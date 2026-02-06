const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 德州撲克牌組產生器
function createDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let deck = [];
    for (let s of suits) {
        for (let v of values) {
            deck.push({ suit: s, value: v });
        }
    }
    // 洗牌 (Fisher-Yates Shuffle)
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

let gameDeck = createDeck();

let gameState = {
    deck: [],
    communityCards: [],
    phase: 'waiting',
    players: {} // 結構改成 { socketId: { hand: [], chips: 1000, name: "" } }
};

io.on('connection', (socket) => {
    // 1. 玩家連線時給他初始籌碼
    gameState.players[socket.id] = {
        hand: [],
        chips: 1000,
        name: socket.id.substring(0, 5)
    };
    
    // 廣播給所有人更新玩家清單
    io.emit('updatePlayerList', gameState.players);

    socket.on('startGame', () => {
        gameState.deck = createDeck();
        gameState.communityCards = [];
        gameState.phase = 'deal';
        // 重置所有人的手牌，但保留籌碼
        for (let id in gameState.players) {
            gameState.players[id].hand = [];
        }
        io.emit('gameLog', "新局開始！");
        io.emit('updateBoard', []);
        io.emit('updatePlayerList', gameState.players);
    });

    socket.on('drawCard', () => {
        if (gameState.phase === 'deal' && gameState.players[socket.id].hand.length === 0) {
            const hand = [gameState.deck.pop(), gameState.deck.pop()];
            gameState.players[socket.id].hand = hand;
            socket.emit('yourHand', hand);
            io.emit('gameLog', `玩家 ${gameState.players[socket.id].name} 已拿牌`);
        }
    });

    // 處理斷線：把玩家從清單移除
    socket.on('disconnect', () => {
        delete gameState.players[socket.id];
        io.emit('updatePlayerList', gameState.players);
    });

    socket.on('nextPhase', () => {
        if (gameState.deck.length < 5) return; // 防呆
        
        if (gameState.phase === 'deal') {
            gameState.communityCards.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
            gameState.phase = 'flop';
        } else if (gameState.phase === 'flop' || gameState.phase === 'turn') {
            gameState.communityCards.push(gameState.deck.pop());
            gameState.phase = (gameState.phase === 'flop') ? 'turn' : 'river';
        }
        io.emit('updateBoard', gameState.communityCards);
        io.emit('gameLog', `當前階段：${gameState.phase.toUpperCase()}`);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});