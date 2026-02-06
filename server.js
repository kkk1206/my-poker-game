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

io.on('connection', (socket) => {
    console.log('玩家連線：' + socket.id);

    // 當玩家點擊「抽牌」時
    socket.on('drawCard', () => {
        if (gameDeck.length === 0) gameDeck = createDeck(); // 沒牌了就重新洗牌
        const card = gameDeck.pop();
        
        // 只傳送給點擊的那個人 (私訊)
        socket.emit('yourCard', card);
        
        // 告訴所有人有人抽牌了（但不說是什麼牌）
        io.emit('gameLog', `玩家 ${socket.id.substring(0, 5)} 抽了一張牌`);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});