const WebSocket = require('ws');
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 遊戲房間
const rooms = new Map();

// 牌組
const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// 生成房間 ID
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 建立新牌組
function createDeck() {
    const deck = [];
    for (const suit of suits) {
        for (const rank of ranks) {
            deck.push({ suit, rank });
        }
    }
    return shuffleDeck(deck);
}

// 洗牌
function shuffleDeck(deck) {
    const newDeck = [...deck];
    for (let i = newDeck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newDeck[i], newDeck[j]] = [newDeck[j], newDeck[i]];
    }
    return newDeck;
}

// 建立遊戲狀態
function createGameState(players) {
    return {
        players: players.map(p => ({
            ...p,
            cards: [],
            chips: 1000,
            currentBet: 0,
            folded: false
        })),
        deck: createDeck(),
        communityCards: [],
        pot: 0,
        currentPlayer: 0,
        stage: 'preflop',
        dealer: 0,
        smallBlind: 10,
        bigBlind: 20
    };
}

// 發牌
function dealCards(gameState) {
    gameState.players.forEach(player => {
        if (!player.folded) {
            player.cards = [gameState.deck.pop(), gameState.deck.pop()];
        }
    });
}

// 發公共牌
function dealCommunityCards(gameState, count) {
    for (let i = 0; i < count; i++) {
        gameState.communityCards.push(gameState.deck.pop());
    }
}

// 開始新回合
function startNewRound(gameState) {
    // 重置玩家狀態
    gameState.players = gameState.players.filter(p => p.chips > 0).map(p => ({
        ...p,
        cards: [],
        currentBet: 0,
        folded: false
    }));

    if (gameState.players.length < 2) {
        return false;
    }

    // 重置遊戲狀態
    gameState.deck = createDeck();
    gameState.communityCards = [];
    gameState.pot = 0;
    gameState.stage = 'preflop';
    gameState.dealer = (gameState.dealer + 1) % gameState.players.length;
    gameState.currentPlayer = (gameState.dealer + 3) % gameState.players.length;

    // 發牌
    dealCards(gameState);

    // 盲注
    const smallBlindIdx = (gameState.dealer + 1) % gameState.players.length;
    const bigBlindIdx = (gameState.dealer + 2) % gameState.players.length;
    
    gameState.players[smallBlindIdx].currentBet = gameState.smallBlind;
    gameState.players[smallBlindIdx].chips -= gameState.smallBlind;
    gameState.pot += gameState.smallBlind;

    gameState.players[bigBlindIdx].currentBet = gameState.bigBlind;
    gameState.players[bigBlindIdx].chips -= gameState.bigBlind;
    gameState.pot += gameState.bigBlind;

    return true;
}

// 處理玩家行動
function handleAction(gameState, playerId, action, amount = 0) {
    const playerIdx = gameState.players.findIndex(p => p.id === playerId);
    if (playerIdx !== gameState.currentPlayer) {
        return { error: '不是你的回合' };
    }

    const player = gameState.players[playerIdx];
    const maxBet = Math.max(...gameState.players.map(p => p.currentBet));

    switch (action) {
        case 'fold':
            player.folded = true;
            break;
        case 'check':
            if (player.currentBet < maxBet) {
                return { error: '無法過牌，需要跟注或棄牌' };
            }
            break;
        case 'call':
            const callAmount = maxBet - player.currentBet;
            const actualCall = Math.min(callAmount, player.chips);
            player.currentBet += actualCall;
            player.chips -= actualCall;
            gameState.pot += actualCall;
            break;
        case 'raise':
            const raiseAmount = amount || gameState.bigBlind;
            const totalBet = maxBet + raiseAmount;
            const betNeeded = totalBet - player.currentBet;
            const actualRaise = Math.min(betNeeded, player.chips);
            player.currentBet += actualRaise;
            player.chips -= actualRaise;
            gameState.pot += actualRaise;
            break;
    }

    // 移到下一個玩家
    moveToNextPlayer(gameState);

    // 檢查是否進入下一階段
    if (isRoundComplete(gameState)) {
        advanceStage(gameState);
    }

    return { success: true };
}

// 移到下一個玩家
function moveToNextPlayer(gameState) {
    let nextPlayer = (gameState.currentPlayer + 1) % gameState.players.length;
    let count = 0;
    
    while (gameState.players[nextPlayer].folded && count < gameState.players.length) {
        nextPlayer = (nextPlayer + 1) % gameState.players.length;
        count++;
    }
    
    gameState.currentPlayer = nextPlayer;
}

// 檢查回合是否完成
function isRoundComplete(gameState) {
    const activePlayers = gameState.players.filter(p => !p.folded);
    if (activePlayers.length === 1) return true;

    const maxBet = Math.max(...gameState.players.map(p => p.currentBet));
    return activePlayers.every(p => p.currentBet === maxBet || p.chips === 0);
}

// 進入下一階段
function advanceStage(gameState) {
    const activePlayers = gameState.players.filter(p => !p.folded);
    
    if (activePlayers.length === 1) {
        endRound(gameState, activePlayers[0]);
        return;
    }

    gameState.players.forEach(p => p.currentBet = 0);

    switch (gameState.stage) {
        case 'preflop':
            dealCommunityCards(gameState, 3);
            gameState.stage = 'flop';
            break;
        case 'flop':
            dealCommunityCards(gameState, 1);
            gameState.stage = 'turn';
            break;
        case 'turn':
            dealCommunityCards(gameState, 1);
            gameState.stage = 'river';
            break;
        case 'river':
            gameState.stage = 'showdown';
            const winner = determineWinner(gameState);
            endRound(gameState, winner);
            return;
    }

    gameState.currentPlayer = (gameState.dealer + 1) % gameState.players.length;
    while (gameState.players[gameState.currentPlayer].folded) {
        gameState.currentPlayer = (gameState.currentPlayer + 1) % gameState.players.length;
    }
}

// 決定贏家（簡化版）
function determineWinner(gameState) {
    const activePlayers = gameState.players.filter(p => !p.folded);
    return activePlayers[0]; // 簡化版：返回第一個未棄牌的玩家
}

// 結束回合
function endRound(gameState, winner) {
    winner.chips += gameState.pot;
    gameState.winner = winner;
    
    setTimeout(() => {
        delete gameState.winner;
        startNewRound(gameState);
        broadcastGameState(gameState);
    }, 5000);
}

// 廣播遊戲狀態
function broadcastGameState(gameState) {
    const room = Array.from(rooms.values()).find(r => r.gameState === gameState);
    if (!room) return;

    room.players.forEach(player => {
        const playerState = {
            ...gameState,
            players: gameState.players.map(p => ({
                ...p,
                cards: p.id === player.id ? p.cards : (p.cards.length > 0 ? [{}, {}] : [])
            }))
        };
        
        player.ws.send(JSON.stringify({
            type: 'gameUpdate',
            gameState: playerState
        }));
    });
}

// WebSocket 連接
wss.on('connection', (ws) => {
    console.log('New client connected');

    ws.on('message', (message) => {
        const data = JSON.parse(message);

        switch (data.type) {
            case 'join':
                handleJoin(ws, data);
                break;
            case 'startGame':
                handleStartGame(data.roomId);
                break;
            case 'action':
                handlePlayerAction(data);
                break;
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

// 處理加入
function handleJoin(ws, data) {
    let roomId = data.roomId;
    let room;

    if (!roomId || !rooms.has(roomId)) {
        roomId = generateRoomId();
        room = {
            id: roomId,
            players: [],
            gameState: null
        };
        rooms.set(roomId, room);
    } else {
        room = rooms.get(roomId);
    }

    const playerId = Math.random().toString(36).substring(2, 15);
    const player = {
        id: playerId,
        name: data.playerName,
        ws: ws
    };

    room.players.push(player);

    ws.send(JSON.stringify({
        type: 'joined',
        playerId: playerId,
        roomId: roomId
    }));

    // 通知所有玩家
    room.players.forEach(p => {
        p.ws.send(JSON.stringify({
            type: 'playerJoined',
            players: room.players.map(pl => ({ id: pl.id, name: pl.name }))
        }));
    });
}

// 開始遊戲
function handleStartGame(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.players.length < 2) {
        return;
    }

    const gameState = createGameState(room.players.map(p => ({
        id: p.id,
        name: p.name
    })));

    room.gameState = gameState;
    startNewRound(gameState);

    room.players.forEach(player => {
        player.ws.send(JSON.stringify({
            type: 'gameStarted',
            gameState: gameState
        }));
    });

    broadcastGameState(gameState);
}

// 處理玩家行動
function handlePlayerAction(data) {
    const room = rooms.get(data.roomId);
    if (!room || !room.gameState) return;

    const result = handleAction(room.gameState, data.playerId, data.action, data.amount);
    
    if (result.error) {
        const player = room.players.find(p => p.id === data.playerId);
        if (player) {
            player.ws.send(JSON.stringify({
                type: 'error',
                message: result.error
            }));
        }
        return;
    }

    broadcastGameState(room.gameState);
}

// 靜態檔案
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});