const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const Solver = require('pokersolver').Hand;
// 修正格式轉換：將 '10' 轉換為 'T' 以符合 pokersolver 要求
const formatCardForSolver = (c) => {
    let v = c.value === '10' ? 'T' : c.value;
    let s = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' }[c.suit];
    return v + s;
};

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

function handleNextPhase() {
    if (gameState.phase === 'preflop') { 
        gameState.communityCards.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
        gameState.phase = 'flop';
    } else if (gameState.phase === 'flop') {
        gameState.communityCards.push(gameState.deck.pop());
        gameState.phase = 'turn';
    } else if (gameState.phase === 'turn') {
        gameState.communityCards.push(gameState.deck.pop());
        gameState.phase = 'river';
    } else if (gameState.phase === 'river') {
        io.emit('gameLog', "🔔 所有公牌已開，請進行最後下注或點擊判定！");
        return; // River 之後不會自動跳轉，需等待 Showdown
    }

    // 重置本輪下注資訊
    for (let id in gameState.players) {
        gameState.players[id].roundBet = 0;
    }
    gameState.currentMaxBet = 0;
    gameState.playersActed = 0;

    io.emit('updateBoard', gameState.communityCards);
    io.emit('updateStatus', { pot: gameState.pot, phase: gameState.phase, currentMaxBet: 0 });
    
    // 回合結束後，回到第一個沒蓋牌的人開始
    gameState.currentTurnIndex = 0;
    findNextActivePlayer(); // 封裝一個尋找玩家的邏輯
    broadcastPlayerList();
}

// 處理全場蓋牌只剩一人的情況
function handleSoloWinner(winnerId) {
    const winner = gameState.players[winnerId];
    io.emit('gameLog', `🎊 其他人都蓋牌了，${winner.name} 贏得底池 ${gameState.pot}！`);
    winner.chips += gameState.pot;
    gameState.pot = 0;
    resetGame(); // 回到等待或開始新局
}

function resetGame() {
    gameState.phase = 'waiting';
    gameState.communityCards = [];
    gameState.pot = 0;
    gameState.currentMaxBet = 0;
    gameState.playersActed = 0;
    for (let id in gameState.players) {
        gameState.players[id].hand = [];
        gameState.players[id].roundBet = 0;
    }
    io.emit('updateBoard', []);
    io.emit('updateStatus', { pot: 0, phase: 'waiting' });
}

function checkRoundOver() {
    const activePlayers = gameState.playerOrder.filter(id => gameState.players[id].hand.length > 0);
    
    // 所有人注額是否等於目前最高注額
    const allMatched = activePlayers.every(id => gameState.players[id].roundBet === gameState.currentMaxBet);
    
    // 所有人是否都點過按鈕 (Acted)
    // 注意：Pre-flop 時，若沒人加注，大盲注必須是最後一個 Acted 的人
    if (gameState.playersActed >= activePlayers.length && allMatched) {
        handleNextPhase();
        return true;
    }
    return false;
}

function broadcastPlayerList() {
    io.emit('updatePlayerList', { 
        players: gameState.players, 
        currentTurn: gameState.playerOrder[gameState.currentTurnIndex] 
    });
}

function findNextActivePlayer(startIndex) {
    let idx = startIndex;
    let count = 0;
    while (count < gameState.playerOrder.length) {
        let player = gameState.players[gameState.playerOrder[idx]];
        if (player && player.hand.length > 0) {
            return idx; // 找到下一個有牌的人
        }
        idx = (idx + 1) % gameState.playerOrder.length;
        count++;
    }
    return idx;
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
    if (gameState.playerOrder.length < 2) return io.emit('gameLog', "❌ 至少需要 2 人才能開始");

    gameState.deck = createDeck();
    gameState.communityCards = [];
    gameState.phase = 'preflop'; // 統一名稱
    gameState.pot = 0;
    gameState.currentMaxBet = 20;
    gameState.playersActed = 0;

    const p1 = gameState.playerOrder[0]; // 小盲
    const p2 = gameState.playerOrder[1]; // 大盲

    gameState.playerOrder.forEach(id => {
        const hand = [gameState.deck.pop(), gameState.deck.pop()];
        gameState.players[id].hand = hand;
        gameState.players[id].roundBet = 0; // 重置
        io.to(id).emit('yourHand', hand);
    });

    // 扣盲注邏輯
    gameState.players[p1].chips -= 10;
    gameState.players[p1].roundBet = 10;
    gameState.players[p2].chips -= 20;
    gameState.players[p2].roundBet = 20;
    gameState.pot = 30;

    gameState.currentTurnIndex = (gameState.playerOrder.length > 2) ? 2 : 0;
    
    io.emit('updateStatus', { 
        pot: gameState.pot, 
        phase: gameState.phase, 
        currentMaxBet: gameState.currentMaxBet // 記得傳這個，前端的「本輪最高注額」才會跳動
    });
    broadcastPlayerList(); // 封裝成函數減少重複代碼
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

        switch(data.action) {
            case 'check':
                // 如果別人有下注，你不能 Check
                if (player.roundBet < gameState.currentMaxBet) {
                    socket.emit('gameLog', "❌ 有人加注，你必須跟注或蓋牌");
                    return;
                }
                gameState.playersActed++;
                io.emit('gameLog', `✅ ${player.name} 過牌`);
                break;
            
            case 'call':
                const diff = gameState.currentMaxBet - player.roundBet;
                if (player.chips < diff) return; // 簡單餘額判斷
                player.chips -= diff;
                player.roundBet += diff;
                gameState.pot += diff;
                gameState.playersActed++;
                io.emit('gameLog', `👤 ${player.name} 跟注 ${diff}`);
                break;

            case 'raise':
                const raiseTo = parseInt(data.amount);
                // 規定：加注額必須大於目前最高注額，且玩家籌碼足夠
                if (raiseTo > gameState.currentMaxBet) {
                    const needed = raiseTo - player.roundBet;
                    if (player.chips < needed) return socket.emit('gameLog', "❌ 籌碼不足");

                    player.chips -= needed;
                    player.roundBet = raiseTo;
                    gameState.pot += needed;
                    gameState.currentMaxBet = raiseTo;
                    
                    // 關鍵：除了加注者，其他人都必須重新表態
                    gameState.playersActed = 1; 
                    io.emit('gameLog', `🔥 ${player.name} 加注到 ${raiseTo}`);
                }
                break;

            case 'fold':
                player.hand = [];
                io.emit('gameLog', `❌ ${player.name} 蓋牌`);
                break;
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
        
        if (gameState.phase === 'preflop') {
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
        // 1. 安全檢查：確保遊戲正在進行中
        if (gameState.phase === 'waiting' || gameState.communityCards.length < 5) {
            return socket.emit('gameLog', "❌ 尚未到攤牌階段");
        }

        let allHands = [];
        let playerIds = [];

        for (let id in gameState.players) {
            const player = gameState.players[id];
            // 確保玩家沒蓋牌 (hand.length === 2)
            if (player.hand && player.hand.length === 2) {
                const fullSevenCards = [
                    ...player.hand.map(formatCardForSolver), 
                    ...gameState.communityCards.map(formatCardForSolver)
                ];
                
                // 解決 indexOf 問題：將 ID 存入 Hand 物件中
                let solvedHand = Solver.solve(fullSevenCards);
                solvedHand.playerId = id; // 自定義屬性標記這是誰的牌
                
                allHands.push(solvedHand);
            }
        }

        if (allHands.length > 0) {
            const winners = Solver.winners(allHands); 
            
            // 取得所有贏家的 ID
            let winnerIds = winners.map(winHand => winHand.playerId);
            
            // 計算分錢 (處理平分底池)
            const share = Math.floor(gameState.pot / winnerIds.length);
            const handDescr = winners[0].descr; // 取得最強牌型名稱 (如 "Full House")

            io.emit('gameLog', `⚖️ 判定結果：${handDescr}`);

            winnerIds.forEach(wid => {
                gameState.players[wid].chips += share;
                io.emit('gameLog', `🎊 ${gameState.players[wid].name} 贏得 ${share} 籌碼！`);
            });

            // 2. 徹底重置並同步狀態
            gameState.pot = 0;
            resetGame(); // 內含 phase = 'waiting'

            // 3. 發送完整的狀態更新給所有人
            io.emit('updateStatus', { pot: 0, phase: 'waiting', currentMaxBet: 0 });
            io.emit('updateBoard', []); // 清空公牌畫面
            io.emit('updatePlayerList', { 
                players: gameState.players, 
                currentTurn: null 
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