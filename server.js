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

//新增一個切換回合的檢查
function checkRoundOver() {
    const activePlayers = gameState.playerOrder.filter(id => gameState.players[id].hand.length > 0);
    const allActed = gameState.playersActed >= activePlayers.length;
    
    // 檢查所有人的投注是否都等於 currentMaxBet (簡化邏輯)
    if (allActed) {
        // 重置本輪狀態，進入下一階段
        gameState.playersActed = 0;
        gameState.currentMaxBet = 0;
        // 自動呼叫 nextPhase 邏輯
        handleNextPhase(); 
    }
}

function nextTurn() {
    let nextIndex = gameState.currentTurnIndex;
    do {
        nextIndex = (nextIndex + 1) % gameState.playerOrder.length;
    } while (gameState.players[gameState.playerOrder[nextIndex]].hand.length === 0);

    gameState.currentTurnIndex = nextIndex;
    
    io.emit('updatePlayerList', { 
        players: gameState.players, 
        currentTurn: gameState.playerOrder[gameState.currentTurnIndex] 
    });
}

function checkRoundOver() {
    const activePlayers = gameState.playerOrder.filter(id => gameState.players[id].hand.length > 0);
    
    // 如果所有人都表態過，且沒有人需要再補錢 (這裡我們先簡化為人數達標)
    if (gameState.playersActed >= activePlayers.length) {
        io.emit('gameLog', "--- 本輪結束，進入下一階段 ---");
        
        // 重置本輪計數器
        gameState.playersActed = 0;
        
        // 自動執行下一階段
        handleNextPhase(); 
        return true;
    }
    return false;
}

function handleNextPhase() {
    if (gameState.phase === 'deal') {
        gameState.communityCards.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
        gameState.phase = 'flop';
    } else if (gameState.phase === 'flop') {
        gameState.communityCards.push(gameState.deck.pop());
        gameState.phase = 'turn';
    } else if (gameState.phase === 'turn') {
        gameState.communityCards.push(gameState.deck.pop());
        gameState.phase = 'river';
    } else if (gameState.phase === 'river') {
        io.emit('gameLog', "🔔 所有公牌已開，請點擊自動判定勝負！");
        // 這裡也可以改成自動觸發 showdown
    }

    // 關鍵：進入下一階段時，清空所有人的本輪投注紀錄
    for (let id in gameState.players) {
        gameState.players[id].roundBet = 0;
    }
    gameState.currentMaxBet = 0;
    gameState.playersActed = 0;

    io.emit('updateBoard', gameState.communityCards);
    io.emit('updateStatus', { pot: gameState.pot, phase: gameState.phase });
    
    // 每輪公牌發完後，動作權通常回到第一個沒蓋牌的人
    gameState.currentTurnIndex = 0; 
    while(gameState.players[gameState.playerOrder[gameState.currentTurnIndex]].hand.length === 0) {
        gameState.currentTurnIndex = (gameState.currentTurnIndex + 1) % gameState.playerOrder.length;
    }
    
    io.emit('updatePlayerList', { 
        players: gameState.players, 
        currentTurn: gameState.playerOrder[gameState.currentTurnIndex] 
    });
}

let gameDeck = createDeck();

let gameState = {
    deck: [],
    communityCards: [],
    phase: 'waiting',
    players: {},
    playerOrder: [], // 新增：儲存玩家 ID 的順序
    currentTurnIndex: 0, // 新增：目前輪到誰的索引
    pot: 0, // 新增：目前的底池金額
    currentMaxBet: 0,        // 目前這一輪最高的人下了多少
    lastRaiser: null,        // 最後一個加注的人（用來判斷回合是否結束）
    playersActed: 0,         // 本輪已表態的人數
    minBet: 20               // 大盲注金額
};

io.on('connection', (socket) => {
    // 玩家連線
    gameState.players[socket.id] = {
        hand: [],
        chips: 1000,
        name: socket.id.substring(0, 5),
        roundBet: 0 // 新增：紀錄本輪已投出的注額
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
        const p1 = gameState.playerOrder[0];
        const p2 = gameState.playerOrder[1];


        // 自動發牌給所有在線玩家
        gameState.playerOrder.forEach(id => {
            const hand = [gameState.deck.pop(), gameState.deck.pop()];
            gameState.players[id].hand = hand;
            // 私密發送手牌給該玩家
            io.to(id).emit('yourHand', hand);
        });

        io.emit('gameLog', "🎴 遊戲開始，手牌已發放！");

        if (p1 && gameState.players[p1]) {
            gameState.players[p1].chips -= 10;
            gameState.pot += 10;
        }
        if (p2 && gameState.players[p2]) {
            gameState.players[p2].chips -= 20;
            gameState.pot += 20;
        }
        io.emit('gameLog', `📢 盲注已扣除：${gameState.players[p1].name} (10), ${gameState.players[p2].name} (20)`);
        
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
        const turnId = gameState.playerOrder[gameState.currentTurnIndex];
        if (socket.id !== turnId) return;

        const player = gameState.players[socket.id];

        if (data.action === 'call') {
            const diff = gameState.currentMaxBet - player.roundBet;
            player.chips -= diff;
            player.roundBet += diff;
            gameState.pot += diff;
            gameState.playersActed++; // 正常增加表態人數
            io.emit('gameLog', `👤 ${player.name} 跟注 ${diff}`);

        } else if (data.action === 'raise') {
            const raiseAmount = parseInt(data.amount); // 玩家想加注到的總金額
            if (raiseAmount > gameState.currentMaxBet) {
                const diff = raiseAmount - player.roundBet;
                player.chips -= diff;
                player.roundBet += diff;
                gameState.pot += diff;
                gameState.currentMaxBet = raiseAmount;
                
                // 關鍵：有人加注，重置已表態人數為 1 (即加注者本人)
                // 這會強迫其他人必須再次表態
                gameState.playersActed = 1; 
                io.emit('gameLog', `🔥 ${player.name} 加注到 ${raiseAmount}`);
            }

        } else if (data.action === 'check') {
            gameState.playersActed++;
            io.emit('gameLog', `✅ ${player.name} 過牌`);
            
        } else if (data.action === 'fold') {
            player.hand = []; 
            io.emit('gameLog', `❌ ${player.name} 蓋牌`);
            // 蓋牌不增加 playersActed，因為 checkRoundOver 會重新計算 activePlayers
        }

        // 檢查剩餘人數與回合狀態
        let activePlayers = gameState.playerOrder.filter(id => gameState.players[id].hand.length > 0);
        
        if (activePlayers.length === 1) {
            handleSoloWinner(activePlayers[0]); // 處理只剩一人的情況
        } else if (!checkRoundOver()) {
            nextTurn();
        }
    });

    socket.on('disconnect', () => {
        gameState.playerOrder = gameState.playerOrder.filter(id => id !== socket.id);
        delete gameState.players[socket.id];
        io.emit('updatePlayerList', { players: gameState.players, currentTurn: gameState.playerOrder[gameState.currentTurnIndex] });
    });

    socket.on('nextPhase', () => {
        if (gameState.deck.length < 5) return;
        
        if (gameState.phase === 'deal') {
            gameState.communityCards.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
            gameState.phase = 'flop';
        } else if (gameState.phase === 'flop') {
            gameState.communityCards.push(gameState.deck.pop());
            gameState.phase = 'turn';
        } else if (gameState.phase === 'turn') {
            gameState.communityCards.push(gameState.deck.pop());
            gameState.phase = 'river';
            io.emit('gameLog', "🔔 已進入最後一輪！請準備攤牌判定。");
        }
        
        io.emit('updateBoard', gameState.communityCards);
        io.emit('updateStatus', { pot: gameState.pot, phase: gameState.phase });
    });

    socket.on('showdown', () => {
        let allHands = [];
        let playerIds = [];

        for (let id in gameState.players) {
            const player = gameState.players[id];
            if (player.hand.length === 2) {
                const formatCard = (c) => {
                    let v = c.value === '10' ? '10' : c.value;
                    let s = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' }[c.suit];
                    return v + s;
                };
                const fullSevenCards = [...player.hand.map(formatCard), ...gameState.communityCards.map(formatCard)];
                allHands.push(Solver.solve(fullSevenCards));
                playerIds.push(id);
            }
        }

        if (allHands.length > 0) {
            const winners = Solver.winners(allHands); 
            // 找出所有贏家的 ID (可能不止一位)
            let winnerIds = [];
            winners.forEach(winHand => {
                const idx = allHands.indexOf(winHand);
                if (idx !== -1) winnerIds.push(playerIds[idx]);
            });

            io.emit('gameLog', `⚖️ 判定結果：${winners[0].descr}`);
            
            // 分派籌碼：總獎金除以贏家數量
            const share = Math.floor(gameState.pot / winnerIds.length);
            winnerIds.forEach(wid => {
                io.emit('declareWinner', wid, share); 
            });
        }
    });
    // 接收贏家判定並發放籌碼
    socket.on('declareWinner', (winnerId, amount) => {
        const winner = gameState.players[winnerId];
        if (winner && gameState.pot > 0) {
            const payout = amount || gameState.pot; // 如果沒傳 amount 就拿走全部
            winner.chips += payout;
            gameState.pot -= payout; // 扣除底池
            
            io.emit('gameLog', `🎊 ${winner.name} 獲得了 ${payout} 籌碼！`);
            
            if (gameState.pot <= 0) gameState.phase = 'waiting';
            
            io.emit('updateStatus', { pot: gameState.pot, phase: gameState.phase });
            io.emit('updatePlayerList', { players: gameState.players, currentTurn: gameState.playerOrder[gameState.currentTurnIndex] });
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

    socket.on('debugState', () => {
        console.log(gameState); // 在伺服器終端機查看數據是否正確
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});