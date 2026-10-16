#!/usr/bin/env python3

import asyncio
import json
import os
import random
import ssl
import string
import time
import uuid

import websockets
from dotenv import load_dotenv

print("Welcome to the Game Boy Online Server!")

load_dotenv('.env')
WEBSOCKET_PORT = os.getenv('WEBSOCKET_PORT')
FULLCHAIN_CERT_PATH = os.getenv('FULLCHAIN_CERT_PATH')
PRIVKEY_PATH = os.getenv('PRIVKEY_PATH')

matchmaking_queue = []

class Client:
    # Needs to be in sync with client!!!
    STATE_ALIVE = 0
    STATE_DEAD = 1
    STATE_WINNER = 2

    def __init__(self, socket, name):
        self.game = None
        self.name = name
        self.uuid = str(uuid.uuid4())
        self.socket = socket
        self.virus_count = 0
        self.state = self.STATE_ALIVE
        self.num_wins = 0
        self.gb_connected = False
        self.awaiting_link_payload = False
        self.match_event = asyncio.Event()

    def set_game(self, game):
        print("Setting game...")
        self.game = game

    async def process(self):
        async for msg in self.socket:
            if self.game.state == Game.GAME_STATE_FINISHED:
                print("Game finished")
                return
            await self.game.process(self, json.loads(msg))

    def set_dead(self):
        self.state = self.STATE_DEAD

    def set_winner(self):
        self.state = self.STATE_WINNER
        self.num_wins += 1

    async def send(self, f):
        print("Sending..")
        await self.socket.send(f)
        print("Done")

    def serialize(self):
        return {
            "name": self.name,
            "virus_count": self.virus_count,
            "state": self.state,
            "uuid": self.uuid,
            "num_wins": self.num_wins,
            "gb_connected": self.gb_connected
        }

class Game:
    # Needs to be in sync with client!!!
    GAME_STATE_LOBBY = 0
    GAME_STATE_SETTINGS = 1
    GAME_STATE_RUNNING = 2
    GAME_STATE_BETWEEN = 3
    GAME_STATE_FINISHED = 4

    LINK_BYTE_GARBAGE_PREFIX = 0xFE
    LINK_BYTE_LOSE = 0xFD
    LINK_BYTE_WIN = 0xF8

    def _generate_name(self):
        lobby_name = ''.join(random.choice(string.ascii_uppercase) for i in range(4))
        print('lobby created with name', lobby_name)
        return lobby_name

    def __init__(self, admin_socket, selection_time=5, is_matchmaking=False):
        self.name = self._generate_name()
        self.admin_socket = admin_socket
        self.clients = [admin_socket]
        self.state = self.GAME_STATE_LOBBY
        self.is_matchmaking = is_matchmaking
        self.settings_phase = None
        self.settings_timer_task = None
        self.settings_sync_task = None
        self.settings_countdown = 0
        self.player_selections = {}
        self.ready_clients = set()
        self.ready_timer_task = None
        try:
            selection_time = int(selection_time)
        except (TypeError, ValueError):
            selection_time = 5
        self.selection_time = max(3, min(20, selection_time))

    def get_gameinfo(self):
        users = []
        for client in self.clients:
            users.append(client.serialize())

        return {
            "type": "game_info",
            "name": self.name,
            "status": self.state,
            "users": users,
            "admin_uuid": self.admin_socket.uuid if self.admin_socket else None
        }

    async def send_gameinfo(self):
        for s in self.clients:
            await self.send_gameinfo_client(s)

    async def send_gameinfo_client(self, client):
        game_info = json.dumps(self.get_gameinfo())
        await client.send(game_info)


    async def send_all(self, data):
        for c in self.clients:
            await c.send(json.dumps(data))

    async def _forward_link_byte(self, sender, byte):
        for c in self.clients:
            if c != sender:
                await c.send(json.dumps({"type": "link_byte", "byte": byte}))


    async def add_client(self, client):
        if self.state != self.GAME_STATE_LOBBY:
            raise("Game not in lobby")
        self.clients.append(client)
        await self.send_gameinfo()

        if len(self.clients) == 2:
            await self.begin_handshake()

    async def begin_handshake(self):
        for c in self.clients:
            c.gb_connected = False
        await self.send_gameinfo()
        await asyncio.sleep(0.3)
        await self.send_all({"type": "request_handshake"})

    async def check_start_settings(self):
        if self.state != self.GAME_STATE_LOBBY:
            return
        
        if len(self.clients) == 2:
            all_connected = all(client.gb_connected for client in self.clients)
            if all_connected:
                await self.start_settings()

    async def start_settings(self):
        print("Starting settings phase!")
        self.state = self.GAME_STATE_SETTINGS
        self.settings_phase = 'virus_level'
        self.settings_countdown = self.selection_time
        
        for client in self.clients:
            self.player_selections[client.uuid] = {
                'virus_level': 0,
                'speed': 0x23,  # MED
                'music': 0x30   # Fever
            }
        
        await self.send_all({
            "type": "start_settings",
            "phase": "virus_level",
            "countdown": self.settings_countdown
        })
        await self.broadcast_settings_sync()
        self.settings_timer_task = asyncio.create_task(self.settings_timer_countdown())
        self.settings_sync_task = asyncio.create_task(self._settings_sync_loop())
    
    async def settings_timer_countdown(self):
        # Tick down once a second, then auto-advance
        while self.settings_countdown > 0:
            await asyncio.sleep(1)
            self.settings_countdown -= 1
            await self.send_all({
                "type": "settings_timer",
                "phase": self.settings_phase,
                "countdown": self.settings_countdown
            })
        
        await self.navigate_next_menu()
    
    async def navigate_next_menu(self):
        # virus_level -> speed -> music, then we're done
        if self.settings_phase == 'virus_level':
            self.settings_phase = 'speed'
            self.settings_countdown = self.selection_time
            
            await self.send_all({
                "type": "navigate_menu",
                "target_menu": 1,
                "phase": "speed",
                "countdown": self.settings_countdown
            })
            
            self.settings_timer_task = asyncio.create_task(self.settings_timer_countdown())
            
        elif self.settings_phase == 'speed':
            self.settings_phase = 'music'
            self.settings_countdown = self.selection_time
            if self.is_matchmaking:
                music_value = random.choice([0x30, 0x31])
                for uuid in self.player_selections:
                    self.player_selections[uuid]['music'] = music_value
                await self.send_all({
                    "type": "navigate_menu",
                    "target_menu": 2,
                    "phase": "music",
                    "countdown": self.settings_countdown
                })
                await self.send_all({
                    "type": "music_sync",
                    "music": music_value
                })
            else:
                await self.send_all({
                    "type": "navigate_menu",
                    "target_menu": 2,
                    "phase": "music",
                    "countdown": self.settings_countdown
                })
            self.settings_timer_task = asyncio.create_task(self.settings_timer_countdown())

        elif self.settings_phase == 'music':
            self.settings_countdown = 0
            self.settings_timer_task = None
            if self.is_matchmaking:
                await self.start_game()

    def _get_client_selection(self, client):
        if client.uuid not in self.player_selections:
            # MED speed, Fever music. the GB defaults
            return {"virus_level": 0, "speed": 0x23, "music": 0x30, "name": client.name}
        s = self.player_selections[client.uuid]
        return {
            "virus_level": s.get("virus_level", 0),
            "speed": s.get("speed", 0x23),
            "music": s.get("music", 0x30),
            "name": client.name,
        }

    async def _settings_sync_loop(self):
        try:
            while self.state == self.GAME_STATE_SETTINGS:
                await asyncio.sleep(0.5)
                if self.state != self.GAME_STATE_SETTINGS:
                    break
                await self.broadcast_settings_sync()
        except asyncio.CancelledError:
            pass

    async def broadcast_settings_sync(self):
        if len(self.clients) != 2:
            return
        c1, c2 = self.clients[0], self.clients[1]
        sel1 = self._get_client_selection(c1)
        sel2 = self._get_client_selection(c2)
        await c1.send(json.dumps({
            "type": "settings_sync",
            "my_selection": sel1,
            "opponent_selection": sel2,
        }))
        await c2.send(json.dumps({
            "type": "settings_sync",
            "my_selection": sel2,
            "opponent_selection": sel1,
        }))

    async def start_game(self):
        print("Starting game!")
        if self.ready_timer_task:
            self.ready_timer_task.cancel()
            self.ready_timer_task = None
        self.ready_clients = set()
        if self.settings_sync_task:
            self.settings_sync_task.cancel()
            try:
                await self.settings_sync_task
            except asyncio.CancelledError:
                pass
            self.settings_sync_task = None
        self.state = self.GAME_STATE_RUNNING
        for c in self.clients:
            c.state = Client.STATE_ALIVE
            c.virus_count = 0
            c.awaiting_link_payload = False

        admin_level = self.player_selections.get(self.admin_socket.uuid, {}).get('virus_level', 0)
        other_clients = [c for c in self.clients if c != self.admin_socket]
        other_level = self.player_selections.get(other_clients[0].uuid, {}).get('virus_level', 0) if other_clients else admin_level
        same_virus_level = (len(self.clients) == 2) and (admin_level == other_level)

        # If both picked the same level, share one bottle + RNG so the runs
        # are identical. Otherwise everyone gets their own.
        if same_virus_level:
            level = admin_level
            bottle = Game.generate_bottle(level)
            rng_sequence = Game.generate_rng_sequence(level)
            await self.send_all({"type": "bottle", "bottle": bottle})
            await self.send_all({"type": "start_game", "rng_sequence": rng_sequence})
        else:
            for c in self.clients:
                level = self.player_selections.get(c.uuid, {}).get('virus_level', 0)
                bottle = Game.generate_bottle(level)
                rng_sequence = Game.generate_rng_sequence(level)
                await c.send(json.dumps({"type": "bottle", "bottle": bottle}))
                await c.send(json.dumps({"type": "start_game", "rng_sequence": rng_sequence}))

    def alive_count(self):
        count = 0
        for c in self.clients:
            if c.state == Client.STATE_ALIVE:
                count += 1
        return count

    def get_last_alive(self):
        for c in self.clients:
            if c.state == Client.STATE_ALIVE:
                return c
        return None

    # Thx diassembled ROM. Based off of RNG generation
    @staticmethod
    def generate_bottle(virus_level=0):
        POSITION_MASKS = [0x3F] * 25
        OFFSET_MASKS = [0x0F] * 15 + [0x17, 0x17, 0x1F, 0x1F, 0x27, 0x27, 0x27, 0x2F, 0x2F, 0x2F]
        VIRUS_TYPES = [0xE0, 0xE1, 0xE2]  # yellow, red, blue
        TYPE_FLAGS = [0x04, 0x02, 0x01]
        ADJACENT_OFFSETS = [(-1, 0), (1, 0), (0, -1), (0, 1)]
        
        bottle = [0xFF] * 128  # ff = empty cell
        virus_count = (virus_level + 1) * 4  # 4 viruses on level 0, 84 on level 20
        level = min(virus_level, 24)  # mask tables only have 25 entries, don't overflow
        mask1, mask2 = POSITION_MASKS[level], OFFSET_MASKS[level]
        
        rdiv_counter = 0
        
        def read_rdiv():
            nonlocal rdiv_counter
            rdiv_counter += 1
            return (int(time.time() * 1000000) + rdiv_counter * 17) & 0xFF
        
        def calculate_position(rdiv):
            swapped = ((rdiv >> 4) | ((rdiv & 0x0F) << 4)) & 0xFF
            return 0x7F - ((swapped & mask1) + (rdiv & mask2))
        
        def get_adjacent_flags(row, col):
            flags = 0
            for dr, dc in ADJACENT_OFFSETS:
                r, c = row + dr, col + dc
                if 0 <= r < 8 and 0 <= c < 16:
                    val = bottle[r * 16 + c]
                    if val in VIRUS_TYPES:
                        flags |= TYPE_FLAGS[VIRUS_TYPES.index(val)]
            return flags
        
        def select_virus_type(adjacent_flags, type_counts, is_first):
            least_used_index = type_counts.index(min(type_counts))
            start_offset = (read_rdiv() % 3) if is_first else 0
            
            for i in range(3):
                idx = (least_used_index + start_offset + i) % 3
                if (adjacent_flags & TYPE_FLAGS[idx]) == 0:
                    return VIRUS_TYPES[idx]
            
            return VIRUS_TYPES[(least_used_index + start_offset) % 3]
        
        type_counts = [0, 0, 0]
        placed = 0
        
        for attempts in range(5000):
            if placed >= virus_count:
                break
            
            rdiv = read_rdiv()
            pos = calculate_position(rdiv)
            
            if pos < 16 or pos >= 128 or bottle[pos] != 0xFF:
                continue
            
            row, col = pos >> 4, pos & 15
            adjacent_flags = get_adjacent_flags(row, col)
            
            if (adjacent_flags & 0x07) == 0x07:
                continue
            
            virus_type = select_virus_type(adjacent_flags, type_counts, placed == 0)
            bottle[pos] = virus_type
            type_counts[VIRUS_TYPES.index(virus_type)] += 1
            placed += 1
        
        bottle_hex = ''.join(f'{b:02X}' for b in bottle)
        print(bottle_hex)
        return bottle_hex

    # Also adapted from the ROM
    @staticmethod
    def generate_rng_sequence(virus_level=0, seed=None):
        def generate_rng_byte(div_value):
            result = 0
            b = div_value & 0xFF
            while b > 0:
                result += 2
                if result == 0x18:
                    result = 0
                b -= 1
            return result
        
        def generate_sequence(initial_div, length=128):
            sequence = []
            div_value = initial_div & 0xFF
            lfsr = (div_value << 8) | (int(time.time() * 1000) & 0xFF)
            if lfsr == 0:
                lfsr = 1
            prev = 0
            
            for i in range(length):
                attempts = 0
                current_div = div_value
                
                while attempts < 3:
                    new_value = generate_rng_byte(current_div)
                    attempts += 1
                    if attempts < 3 and (new_value & 0xFC) == (prev & 0xFC):
                        current_div = (current_div + 1) & 0xFF
                    else:
                        break
                
                sequence.append(new_value)
                prev = new_value
                lfsr = (lfsr >> 1) ^ (-(lfsr & 1) & 0xB400)
                div_increment = 1 + (lfsr & 0x3)
                div_value = (div_value + div_increment) & 0xFF
            
            return sequence
        
        if seed is None:
            initial_div = (int(time.time() * 1000) + random.randint(0, 1000)) & 0xFF
        else:
            initial_div = seed
        
        div_value = initial_div
        
        for i in range(3):
            generate_sequence(div_value, 1)
            div_value = (div_value + 1) & 0xFF
        
        sequence = generate_sequence(div_value, 128)
        rng_hex = ''.join(f'{b:02X}' for b in sequence)
        return rng_hex


    async def process(self, client, msg):
        print(f"Processing {client.name} with msg {msg}")
        if msg["type"] == "gb_connected":
            client.gb_connected = True
            await self.send_gameinfo()
            await self.check_start_settings()
        elif msg["type"] == "start_settings":
            # Check if game state is correct.
            if self.state != self.GAME_STATE_LOBBY:
                print("Error: Game not in lobby", self.state)
                return
            # Check if admin.
            if client != self.admin_socket:
                print("Error: Not an admin.")
                return
            await self.start_settings()
        elif msg["type"] == "settings_update":
            # Check if game state is correct.
            if self.state != self.GAME_STATE_SETTINGS:
                print("Error: Not in settings phase")
                return
            if client.uuid not in self.player_selections:
                self.player_selections[client.uuid] = {}
            
            if 'virus_level' in msg:
                self.player_selections[client.uuid]['virus_level'] = msg['virus_level']
            if 'speed' in msg:
                self.player_selections[client.uuid]['speed'] = msg['speed']
            if 'music' in msg and not self.is_matchmaking:
                self.player_selections[client.uuid]['music'] = msg['music']
            
            await self.broadcast_settings_sync()
        elif msg["type"] == "music_select":
            if self.is_matchmaking:
                return
            # Check if game state is correct.
            if self.state != self.GAME_STATE_SETTINGS:
                print("Error: Not in settings phase")
                return
            # Check if admin. (only the host gets to pick music)
            if client != self.admin_socket:
                print("Error: Not an admin.")
                return
            
            music_value = msg.get('music', 0x30)
            for uuid in self.player_selections:
                self.player_selections[uuid]['music'] = music_value
            await self.send_all({
                "type": "music_sync",
                "music": music_value
            })
        elif msg["type"] == "start":
            if self.is_matchmaking:
                print("Error: Matchmaking games auto-start / use ready_next.")
                return
            # Check if game state is correct.
            if self.state != self.GAME_STATE_SETTINGS and self.state != self.GAME_STATE_BETWEEN:
                print("Error: Cannot start game", self.state)
                return
            # Check if admin.
            if client != self.admin_socket:
                print("Error: Not an admin.")
                return
            
            if self.settings_timer_task:
                self.settings_timer_task.cancel()
                self.settings_timer_task = None
            await self.start_game()
        elif msg["type"] == "virus_update":
            if self.state != self.GAME_STATE_RUNNING:
                print("Game is not running. Error.")
                return
            client.virus_count = msg["virus_count"]
            await self.send_gameinfo()
        elif msg["type"] == "link_byte":
            if self.state not in (self.GAME_STATE_RUNNING, self.GAME_STATE_BETWEEN, self.GAME_STATE_FINISHED):
                return
            byte = msg.get("byte")
            if not isinstance(byte, int) or byte < 0 or byte > 0xFF:
                return

            # After 0xFE the next byte is garbage payload, relay it without special casing.
            if client.awaiting_link_payload:
                client.awaiting_link_payload = False
                await self._forward_link_byte(client, byte)
                return

            # 0xFE starts a two-byte garbage transfer (prefix then payload).
            if byte == self.LINK_BYTE_GARBAGE_PREFIX:
                client.awaiting_link_payload = True
                await self._forward_link_byte(client, byte)
                return

            # 0xFD / 0xF8: end-of-round signals on the link, forward to the other player.
            if byte in (self.LINK_BYTE_LOSE, self.LINK_BYTE_WIN):
                await self._forward_link_byte(client, byte)
        elif msg["type"] == "dead":
            if self.state == self.GAME_STATE_FINISHED or self.state == self.GAME_STATE_BETWEEN:
                # User might just have died.. ignore
                return
            if self.state != self.GAME_STATE_RUNNING:
                print("Game is not running. Error.")
                return
            print("User died")
            client.set_dead()
            await client.send(json.dumps({"type": "lose"}))
            winner = self.get_last_alive()
            if winner is not None:
                # We have a winner!
                print("We have a winner!")
                winner.set_winner()
                await winner.send(json.dumps({"type": "win"}))
            self.ready_clients = set()
            self.state = self.GAME_STATE_BETWEEN
            await self.send_gameinfo()
        elif msg["type"] == "win":
            if self.state != self.GAME_STATE_RUNNING and self.state != self.GAME_STATE_BETWEEN:
                return
            if self.state == self.GAME_STATE_BETWEEN:
                return
            # We have a winner!
            client.set_winner()
            for c in self.clients:
                if c != client:
                    c.set_dead()
                    await c.send(json.dumps({"type": "lose"}))
            await client.send(json.dumps({"type": "win"}))
            self.ready_clients = set()
            self.state = self.GAME_STATE_BETWEEN
            await self.send_gameinfo()
        elif msg["type"] == "ready_next":
            if self.state != self.GAME_STATE_BETWEEN:
                return
            if not self.is_matchmaking:
                return
            self.ready_clients.add(client.uuid)
            await self.send_all({"type": "player_ready", "uuid": client.uuid})
            if len(self.ready_clients) >= len(self.clients):
                if self.ready_timer_task:
                    self.ready_timer_task.cancel()
                    self.ready_timer_task = None
                await self.start_game()
            elif len(self.ready_clients) == 1:
                await self.send_all({"type": "countdown_started", "seconds": 10})
                self.ready_timer_task = asyncio.create_task(self._ready_countdown())

    async def _ready_countdown(self):
        try:
            await asyncio.sleep(10)
            if self.state == self.GAME_STATE_BETWEEN and self.is_matchmaking:
                await self.start_game()
        except asyncio.CancelledError:
            pass

    async def handle_client_disconnect(self, disconnected_client):
        print(f"Client {disconnected_client.name} disconnected from game {self.name}")

        if disconnected_client in self.clients:
            self.clients.remove(disconnected_client)

        if disconnected_client == self.admin_socket and len(self.clients) > 0:
            self.admin_socket = self.clients[0]
            print(f"Admin reassigned to {self.admin_socket.name}")

        if self.ready_timer_task:
            self.ready_timer_task.cancel()
            self.ready_timer_task = None
        self.ready_clients.discard(disconnected_client.uuid)

        if self.state == self.GAME_STATE_RUNNING:
            disconnected_client.set_dead()
            alive_count = self.alive_count()
            if alive_count == 1:
                winner = self.get_last_alive()
                if winner:
                    winner.set_winner()
                    try:
                        await winner.send(json.dumps({
                            "type": "opponent_disconnect"
                        }))
                        if not self.is_matchmaking:
                            await winner.send(json.dumps({
                                "type": "win"
                            }))
                    except websockets.exceptions.ConnectionClosed:
                        print(f"Winner {winner.name} also disconnected")
                if self.is_matchmaking:
                    self.state = self.GAME_STATE_FINISHED
                else:
                    self.state = self.GAME_STATE_BETWEEN
            elif alive_count == 0:
                self.state = self.GAME_STATE_FINISHED
            else:
                await self.send_gameinfo()

        elif self.state in (self.GAME_STATE_BETWEEN, self.GAME_STATE_SETTINGS, self.GAME_STATE_LOBBY):
            if len(self.clients) <= 1:
                for c in list(self.clients):
                    try:
                        await c.send(json.dumps({
                            "type": "opponent_disconnect"
                        }))
                    except websockets.exceptions.ConnectionClosed:
                        print(f"Notify failed - {c.name} also disconnected")
                if self.is_matchmaking or len(self.clients) == 0:
                    self.state = self.GAME_STATE_FINISHED
                else:
                    await self.send_gameinfo()
            else:
                await self.send_gameinfo()

        if len(self.clients) == 0:
            self.state = self.GAME_STATE_FINISHED
            if self.name in games:
                del games[self.name]


games = {}

def parse_register_msg(msg):
    j = json.loads(msg)
    if j["type"] != "register":
        return None

    return j

async def newserver(websocket):
    path = getattr(websocket, "path", None)
    if path is None and hasattr(websocket, "request"):
        path = websocket.request.path
    print("Newserver")
    # First wait for registration message.
    # Without it we don't do anything.
    msg = parse_register_msg(await websocket.recv())
    if msg == None:
        error = {
            "type": "error",
            "msg": "Invalid registration message"
        }
        await websocket.send(json.dumps(error))
        return
    name = msg["name"]
    print(f"New client with name: {name}")

    # Next we create a client structure
    client = Client(websocket, name)
    # Send uuid to client
    await client.send(json.dumps({
        "type": "user_info",
        "uuid": client.uuid
    }))

    # Either create a new game
    if(path == "/create"):
        print("Create game")
        selection_time = msg.get("selection_time", 5)
        new_game = Game(client, selection_time=selection_time)
        while new_game.name in games:
            new_game = Game(client, selection_time=selection_time)
        client.set_game(new_game)

        print("Sending gameinfo..")
        await new_game.send_gameinfo()
        print("Done")

        games[new_game.name] = new_game

        try:
            await client.process()
        except websockets.exceptions.ConnectionClosed:
            print(f"Client {client.name} disconnected")
            await new_game.handle_client_disconnect(client)
    # Or join an existing game
    elif(path.startswith("/join/")):
        game_name = path[6:].upper()
        print(f"join game with id: >{game_name}<")
        if not game_name in games:
            error = {
                "type": "error",
                "msg": "Game not found."
            }
            await websocket.send(json.dumps(error))
            return

        game = games[game_name]
        if game.is_matchmaking:
            error = {
                "type": "error",
                "msg": "Game not found."
            }
            await websocket.send(json.dumps(error))
            return

        client.set_game(game)

        await game.add_client(client)

        print("Sending gameinfo..")
        await game.send_gameinfo()
        try:
            await client.process()
        except websockets.exceptions.ConnectionClosed:
            print(f"Client {client.name} disconnected")
            await game.handle_client_disconnect(client)
    elif(path == "/matchmake"):
        print("Matchmaking request")
        client.match_event = asyncio.Event()
        matchmaking_queue.append(client)

        if len(matchmaking_queue) >= 2:
            player1 = matchmaking_queue.pop(0)
            player2 = matchmaking_queue.pop(0)

            print(f"Pairing {player1.name} with {player2.name}")

            new_game = Game(player1, is_matchmaking=True)
            while new_game.name in games:
                new_game = Game(player1, is_matchmaking=True)

            player1.set_game(new_game)
            player2.set_game(new_game)
            new_game.clients.append(player2)
            games[new_game.name] = new_game

            match_info = {
                "type": "match_found",
                "name": new_game.name,
                "users": [c.serialize() for c in new_game.clients],
                "admin_uuid": player1.uuid
            }
            await player1.send(json.dumps(match_info))
            await player2.send(json.dumps(match_info))

            player1.match_event.set()
            await asyncio.sleep(0)
            await new_game.begin_handshake()

            try:
                await client.process()
            except websockets.exceptions.ConnectionClosed:
                print(f"Client {client.name} disconnected during matchmaking game")
                await new_game.handle_client_disconnect(client)
        else:
            print(f"{client.name} waiting in matchmaking queue (queue size: {len(matchmaking_queue)})")
            matched = False
            queued_msg = None
            try:
                while True:
                    recv_task = asyncio.create_task(client.socket.recv())
                    match_task = asyncio.create_task(client.match_event.wait())

                    done, pending = await asyncio.wait(
                        [recv_task, match_task],
                        return_when=asyncio.FIRST_COMPLETED
                    )

                    for task in pending:
                        task.cancel()
                        try:
                            await task
                        except (asyncio.CancelledError, websockets.exceptions.ConnectionClosed, Exception):
                            pass

                    if recv_task in done:
                        try:
                            raw = recv_task.result()
                        except websockets.exceptions.ConnectionClosed:
                            raise
                        data = json.loads(raw)
                        if data.get("type") == "cancel_matchmaking":
                            print(f"{client.name} cancelled matchmaking")
                            if client in matchmaking_queue:
                                matchmaking_queue.remove(client)
                            return
                        if client.game:
                            queued_msg = data
                            matched = True
                            break

                    if match_task in done:
                        matched = True
                        break
            except websockets.exceptions.ConnectionClosed:
                print(f"{client.name} disconnected while waiting in queue")
                if client in matchmaking_queue:
                    matchmaking_queue.remove(client)
                if client.game:
                    await client.game.handle_client_disconnect(client)
                return

            if matched:
                try:
                    if queued_msg:
                        await client.game.process(client, queued_msg)
                    await client.process()
                except websockets.exceptions.ConnectionClosed:
                    print(f"Client {client.name} disconnected during matchmaking game")
                    if client.game:
                        await client.game.handle_client_disconnect(client)

    else:
        print(f"Unhandled path: {path}")



async def main():
    use_ssl = os.getenv('USE_SSL', 'false').lower() == 'true'
    
    if use_ssl:
        try:
            ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ssl_context.load_cert_chain(certfile=FULLCHAIN_CERT_PATH, keyfile=PRIVKEY_PATH)
            async with websockets.serve(newserver, '0.0.0.0', WEBSOCKET_PORT, ping_interval=None, ssl=ssl_context):
                print(f"WebSocket server started on port {WEBSOCKET_PORT}")
                await asyncio.Future()
        except Exception as e:
            print(f"Failed to start with SSL: {e}")
            use_ssl = False
    
    if not use_ssl:
        async with websockets.serve(newserver, '0.0.0.0', WEBSOCKET_PORT, ping_interval=None):
            print(f"WebSocket server started on port {WEBSOCKET_PORT}")
            await asyncio.Future()

asyncio.run(main())
