const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const Solver = require('pokersolver').Hand;

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
    players: {},
    playerOrder: [], // 新增：儲存玩家 ID 的順序
    currentTurnIndex: 0, // 新增：目前輪到誰的索引
    pot: 0 // 新增：目前的底池金額
};

io.on('connection', (socket) => {
    // 玩家連線
    gameState.players[socket.id] = {
        hand: [],
        chips: 1000,
        name: socket.id.substring(0, 5)
    };
    gameState.playerOrder.push(socket.id); // 加入順序表
    
    io.emit('updatePlayerList', { players: gameState.players, currentTurn: gameState.playerOrder[gameState.currentTurnIndex] });

    socket.on('startGame', () => {
        gameState.deck = createDeck();
        gameState.communityCards = [];
        gameState.phase = 'deal';
        gameState.pot = 0;
        gameState.currentTurnIndex = 0; // 從第一個玩家開始
        for (let id in gameState.players) {
            gameState.players[id].hand = [];
        }
        io.emit('gameLog', "新局開始！由第一位玩家開始動作。");
        io.emit('updateBoard', []);
        io.emit('updateStatus', { pot: gameState.pot, phase: gameState.phase });
        io.emit('updatePlayerList', { players: gameState.players, currentTurn: gameState.playerOrder[gameState.currentTurnIndex] });
    });

    socket.on('drawCard', () => {
        if (gameState.phase === 'deal' && gameState.players[socket.id].hand.length === 0) {
            const hand = [gameState.deck.pop(), gameState.deck.pop()];
            gameState.players[socket.id].hand = hand;
            socket.emit('yourHand', hand);
            io.emit('gameLog', `玩家 ${gameState.players[socket.id].name} 已拿牌`);
        }
    });

    // 處理玩家動作 (跟注範例)
    socket.on('playerAction', (data) => {
        // 檢查是否輪到該玩家
        if (socket.id !== gameState.playerOrder[gameState.currentTurnIndex]) {
            socket.emit('gameLog', "還沒輪到你！");
            return;
        }

        if (data.action === 'call') {
            const amount = 50; // 假設固定跟注 50
            if (gameState.players[socket.id].chips >= amount) {
                gameState.players[socket.id].chips -= amount;
                gameState.pot += amount;
                io.emit('gameLog', `玩家 ${gameState.players[socket.id].name} 跟注 50`);
            }
        }

        // 輪到下一位
        gameState.currentTurnIndex = (gameState.currentTurnIndex + 1) % gameState.playerOrder.length;
        
        io.emit('updatePlayerList', { players: gameState.players, currentTurn: gameState.playerOrder[gameState.currentTurnIndex] });
        io.emit('updateStatus', { pot: gameState.pot, phase: gameState.phase });
    });

    socket.on('disconnect', () => {
        gameState.playerOrder = gameState.playerOrder.filter(id => id !== socket.id);
        delete gameState.players[socket.id];
        io.emit('updatePlayerList', { players: gameState.players, currentTurn: gameState.playerOrder[gameState.currentTurnIndex] });
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

    socket.on('showdown', () => {
        let allHands = [];
        let playerIds = [];

        for (let id in gameState.players) {
            const player = gameState.players[id];
            if (player.hand.length === 2) {
                // 轉換牌格式以符合 pokersolver 的要求 (例如: {suit:'♠', value:'A'} -> 'As')
                const formatCard = (c) => {
                    let v = c.value === '10' ? '10' : c.value;
                    let s = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' }[c.suit];
                    return v + s;
                };

                const fullSevenCards = [
                    ...player.hand.map(formatCard),
                    ...gameState.communityCards.map(formatCard)
                ];

                allHands.push(Solver.solve(fullSevenCards));
                playerIds.push(id);
            }
        }

        if (allHands.length > 0) {
            const winners = Solver.winners(allHands); // 判斷誰最強
            // 找到贏家對應的 socket.id
            const winnerIndex = allHands.indexOf(winners[0]);
            const winnerId = playerIds[winnerIndex];
            
            // 觸發之前寫好的贏家邏輯
            io.emit('gameLog', `⚖️ 自動結算完成！牌型：${winners[0].descr}`);
            io.emit('triggerWinner', winnerId); // 這邊連動到 declareWinner 的邏輯
        }
    });
    // 接收贏家判定並發放籌碼
    socket.on('declareWinner', (winnerId) => {
        if (gameState.pot <= 0) return;

        const winner = gameState.players[winnerId];
        if (winner) {
            winner.chips += gameState.pot; // 撥款
            io.emit('gameLog', `🏆 最終贏家：${winner.name}！贏得 ${gameState.pot} 籌碼！`);
            gameState.pot = 0; // 清空底池
            gameState.phase = 'waiting';

            // 更新所有人的狀態
            io.emit('updateStatus', { pot: gameState.pot, phase: gameState.phase });
            io.emit('updatePlayerList', { 
                players: gameState.players, 
                currentTurn: gameState.playerOrder[gameState.currentTurnIndex] 
            });
        }
    });

    // 讓玩家可以改名字
    socket.on('setName', (newName) => {
        if (newName && newName.length < 10) {
            gameState.players[socket.id].name = newName;
            io.emit('updatePlayerList', { 
                players: gameState.players, 
                currentTurn: gameState.playerOrder[gameState.currentTurnIndex] 
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});