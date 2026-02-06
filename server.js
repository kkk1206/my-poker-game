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
    players: {} // 用來記錄哪些玩家已經拿過牌了
};

io.on('connection', (socket) => {
    socket.emit('updateBoard', gameState.communityCards);

    socket.on('startGame', () => {
        gameState.deck = createDeck();
        gameState.communityCards = [];
        gameState.phase = 'deal';
        gameState.players = {}; // 重置玩家狀態
        io.emit('gameLog', "新局開始！請玩家抽手牌。");
        io.emit('updateBoard', []);
    });

    socket.on('drawCard', () => {
        // 檢查是否已經開始遊戲且玩家還沒拿過牌
        if (gameState.phase === 'deal' && !gameState.players[socket.id]) {
            const hand = [gameState.deck.pop(), gameState.deck.pop()]; // 一次給兩張
            gameState.players[socket.id] = hand;
            
            socket.emit('yourHand', hand); // 改用 yourHand 事件傳送陣列
            io.emit('gameLog', `玩家 ${socket.id.substring(0, 5)} 已拿牌`);
        }
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