const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 提供靜態檔案
app.use(express.static(path.join(__dirname, 'public')));

// 主路由返回 index.html
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    
    // 檢查檔案是否存在
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        // 檔案不存在時顯示詳細錯誤
        res.status(404).send(`
            <h1>Error: index.html not found</h1>
            <p>Expected location: ${indexPath}</p>
            <p>Current directory: ${__dirname}</p>
            <p>Files in current directory:</p>
            <pre>${fs.readdirSync(__dirname).join('\n')}</pre>
            <p>Please make sure index.html is in the 'public' folder</p>
        `);
    }
});

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
        players: players.map((p, idx) => ({
            ...p,
            cards: [],
            chips: 1000,
            currentBet: 0,
            folded: false,
            hasActed: false,
            actedThisRound: false,
            position: idx
        })),
        deck: createDeck(),
        communityCards: [],
        pot: 0,
        sidePots: [],
        currentPlayerIdx: 0,
        stage: 'preflop',
        dealerIdx: -1,  // -1 表示還沒開始，第一手會變成 0
        smallBlind: 10,
        bigBlind: 20,
        lastRaiseAmount: 20,
        roundActions: 0,
        actionLog: [], // 遊戲日誌
        handNumber: 0,
        isFirstRound: true,
        actionTimer: null,  // 行動計時器
        actionTimeout: 60000,  // 60秒超時
        actionSequence: 0  // 行動序號，防止重複提交
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
        totalBet: 0,
        folded: false,
        hasActed: false,
        actedThisRound: false  // 這一輪是否真正行動過
    }));

    if (gameState.players.length < 2) {
        return false;
    }

    // 增加手數並重置日誌
    gameState.handNumber = (gameState.handNumber || 0) + 1;
    gameState.actionLog = [];
    gameState.actionLog.push({
        action: 'NEW_HAND',
        handNumber: gameState.handNumber,
        players: gameState.players.map(p => ({ name: p.name, chips: p.chips }))
    });

    // 重置遊戲狀態
    gameState.deck = createDeck();
    gameState.communityCards = [];
    gameState.pot = 0;
    gameState.sidePots = [];
    gameState.stage = 'preflop';
    gameState.dealerIdx = (gameState.dealerIdx + 1) % gameState.players.length;
    gameState.lastRaiseAmount = gameState.bigBlind;
    gameState.roundActions = 0;
    gameState.isFirstRound = true;  // 標記這是翻牌前的第一輪

    // 發牌
    dealCards(gameState);

    // 盲注位置
    let smallBlindIdx, bigBlindIdx, firstToActIdx;
    
    if (gameState.players.length === 2) {
        // 兩人桌：莊家是小盲，另一位是大盲
        smallBlindIdx = gameState.dealerIdx;
        bigBlindIdx = (gameState.dealerIdx + 1) % gameState.players.length;
        // 翻牌前小盲先行動
        firstToActIdx = smallBlindIdx;
    } else {
        // 三人以上：莊家後第一位是小盲，第二位是大盲
        smallBlindIdx = (gameState.dealerIdx + 1) % gameState.players.length;
        bigBlindIdx = (gameState.dealerIdx + 2) % gameState.players.length;
        // 翻牌前大盲後第一位先行動
        firstToActIdx = (gameState.dealerIdx + 3) % gameState.players.length;
    }
    
    // 小盲下注（可能少於標準盲注，如果籌碼不足）
    const actualSmallBlind = Math.min(gameState.smallBlind, gameState.players[smallBlindIdx].chips);
    gameState.players[smallBlindIdx].currentBet = actualSmallBlind;
    gameState.players[smallBlindIdx].chips -= actualSmallBlind;
    gameState.players[smallBlindIdx].totalBet = actualSmallBlind;
    gameState.pot += actualSmallBlind;
    
    // 檢查小盲是否 all-in
    const smallBlindAllIn = gameState.players[smallBlindIdx].chips === 0;

    // 大盲下注（可能少於標準盲注，如果籌碼不足）
    const actualBigBlind = Math.min(gameState.bigBlind, gameState.players[bigBlindIdx].chips);
    gameState.players[bigBlindIdx].currentBet = actualBigBlind;
    gameState.players[bigBlindIdx].chips -= actualBigBlind;
    gameState.players[bigBlindIdx].totalBet = actualBigBlind;
    gameState.pot += actualBigBlind;
    
    // 檢查大盲是否 all-in
    const bigBlindAllIn = gameState.players[bigBlindIdx].chips === 0;
    
    // 記錄盲注
    gameState.actionLog.push({
        action: 'BLINDS',
        smallBlind: { player: gameState.players[smallBlindIdx].name, amount: actualSmallBlind, allIn: smallBlindAllIn },
        bigBlind: { player: gameState.players[bigBlindIdx].name, amount: actualBigBlind, allIn: bigBlindAllIn }
    });
    
    // 翻牌前：盲注不算自願行動，都還沒真正行動過
    // 但如果盲注 all-in 了，設置 hasActed 為 true（他們無法再行動）
    gameState.players[smallBlindIdx].hasActed = smallBlindAllIn;
    gameState.players[bigBlindIdx].hasActed = bigBlindAllIn;
    gameState.players[smallBlindIdx].actedThisRound = smallBlindAllIn;
    gameState.players[bigBlindIdx].actedThisRound = bigBlindAllIn;

    // 設置第一個行動的玩家（跳過 all-in 的玩家）
    gameState.currentPlayerIdx = firstToActIdx;
    
    // 如果第一個玩家已經 all-in 或棄牌，找下一個
    let searchCount = 0;
    while ((gameState.players[gameState.currentPlayerIdx].chips === 0 || 
            gameState.players[gameState.currentPlayerIdx].folded) && 
           searchCount < gameState.players.length) {
        gameState.currentPlayerIdx = (gameState.currentPlayerIdx + 1) % gameState.players.length;
        searchCount++;
    }

    return true;
}

// 開始行動計時器
function startActionTimer(gameState, roomId) {
    // 清除舊的計時器
    if (gameState.actionTimer) {
        clearTimeout(gameState.actionTimer);
    }
    
    const currentPlayer = gameState.players[gameState.currentPlayerIdx];
    
    // 如果當前玩家已經 all-in 或棄牌，不需要計時
    if (!currentPlayer || currentPlayer.folded || currentPlayer.chips === 0) {
        return;
    }
    
    // 設置新的計時器
    gameState.actionTimer = setTimeout(() => {
        console.log(`${currentPlayer.name} timed out - auto fold`);
        
        // 超時自動棄牌
        currentPlayer.folded = true;
        currentPlayer.hasActed = true;
        currentPlayer.actedThisRound = true;
        
        gameState.actionLog.push({
            action: 'TIMEOUT_FOLD',
            player: currentPlayer.name,
            stage: gameState.stage
        });
        
        // 移到下一個玩家
        moveToNextPlayer(gameState);
        
        // 檢查是否進入下一階段
        if (isRoundComplete(gameState)) {
            advanceStage(gameState);
        }
        
        // 廣播更新
        broadcastGameState(gameState);
        
        // 為下一個玩家啟動計時器
        startActionTimer(gameState, roomId);
    }, gameState.actionTimeout);
}

// 處理玩家行動
function handleAction(gameState, playerId, action, amount = 0) {
    const playerIdx = gameState.players.findIndex(p => p.id === playerId);
    if (playerIdx === -1) {
        return { error: '找不到玩家' };
    }
    
    if (playerIdx !== gameState.currentPlayerIdx) {
        return { error: '不是你的回合' };
    }

    const player = gameState.players[playerIdx];
    if (player.folded) {
        return { error: '你已經棄牌' };
    }
    
    if (player.chips === 0) {
        return { error: '你已經 all-in，無法再行動' };
    }

    const maxBet = Math.max(...gameState.players.map(p => p.currentBet));

    switch (action) {
        case 'fold':
            player.folded = true;
            player.hasActed = true;
            player.actedThisRound = true;
            
            gameState.actionLog.push({
                action: 'FOLD',
                player: player.name,
                stage: gameState.stage
            });
            break;
            
        case 'check':
            if (player.currentBet < maxBet) {
                return { error: '無法過牌，需要跟注或棄牌' };
            }
            player.hasActed = true;
            player.actedThisRound = true;
            
            gameState.actionLog.push({
                action: 'CHECK',
                player: player.name,
                stage: gameState.stage
            });
            break;
            
        case 'call':
            const callAmount = maxBet - player.currentBet;
            if (callAmount === 0) {
                return { error: '請使用過牌' };
            }
            if (callAmount < 0) {
                return { error: '下注邏輯錯誤' };
            }
            
            const actualCall = Math.min(callAmount, player.chips);
            player.currentBet += actualCall;
            player.chips -= actualCall;
            gameState.pot += actualCall;
            player.hasActed = true;
            player.actedThisRound = true;
            
            // 追蹤總投入
            player.totalBet = (player.totalBet || 0) + actualCall;
            
            // 如果 all-in
            const isCallAllIn = player.chips === 0 && actualCall < callAmount;
            if (isCallAllIn) {
                console.log(`${player.name} all-in (call) with ${actualCall}`);
            }
            
            gameState.actionLog.push({
                action: isCallAllIn ? 'CALL_ALL_IN' : 'CALL',
                player: player.name,
                amount: actualCall,
                stage: gameState.stage
            });
            break;
            
        case 'raise':
            if (amount <= 0) {
                return { error: '加注金額必須大於 0' };
            }
            
            // 驗證金額是否為整數
            if (!Number.isInteger(amount)) {
                return { error: '加注金額必須是整數' };
            }
            
            // 驗證金額是否過大（防止惡意輸入）
            if (amount > 1000000) {
                return { error: '加注金額過大' };
            }
            
            // 計算需要跟注的金額
            const currentBetNeeded = maxBet - player.currentBet;
            
            // 檢查玩家是否有足夠的籌碼
            if (player.chips <= currentBetNeeded) {
                return { error: '籌碼不足以加注，請選擇跟注或 all-in' };
            }
            
            if (player.chips < currentBetNeeded + amount) {
                // All-in 的情況
                const allInAmount = player.chips;
                const actualRaiseAmount = allInAmount - currentBetNeeded;
                
                // 檢查 all-in 金額是否至少等於最小加注（如果有足夠籌碼的話）
                const lastRaiseIncrement = gameState.lastRaiseAmount;
                
                // All-in 時允許任何金額（即使小於最小加注）
                player.currentBet += allInAmount;
                player.chips = 0;
                gameState.pot += allInAmount;
                player.hasActed = true;
                player.actedThisRound = true;
                player.totalBet = (player.totalBet || 0) + allInAmount;
                
                // 如果 all-in 金額大於等於最小加注，其他玩家需要重新行動
                if (actualRaiseAmount >= lastRaiseIncrement) {
                    gameState.players.forEach((p, idx) => {
                        if (idx !== playerIdx && !p.folded && p.chips > 0) {
                            p.hasActed = false;
                            // 不重置 actedThisRound，因為他們確實行動過了
                        }
                    });
                }
                
                console.log(`${player.name} all-in raised ${actualRaiseAmount}`);
                
                gameState.actionLog.push({
                    action: 'RAISE_ALL_IN',
                    player: player.name,
                    amount: actualRaiseAmount,
                    totalBet: player.currentBet,
                    stage: gameState.stage
                });
            } else {
                // 正常加注
                const lastRaiseIncrement = gameState.lastRaiseAmount;
                
                if (amount < lastRaiseIncrement) {
                    return { error: `最小加注金額為 ${lastRaiseIncrement}` };
                }
                
                const totalRaise = currentBetNeeded + amount;
                
                player.currentBet += totalRaise;
                player.chips -= totalRaise;
                gameState.pot += totalRaise;
                player.hasActed = true;
                player.actedThisRound = true;
                player.totalBet = (player.totalBet || 0) + totalRaise;
                
                // 更新最後加注增量（這次加注的增量）
                gameState.lastRaiseAmount = amount;
                
                // 所有其他玩家需要重新行動
                gameState.players.forEach((p, idx) => {
                    if (idx !== playerIdx && !p.folded && p.chips > 0) {
                        p.hasActed = false;
                        // 不重置 actedThisRound
                    }
                });
                
                console.log(`${player.name} raised ${amount}, total bet: ${player.currentBet}, total invested: ${player.totalBet}`);
                
                gameState.actionLog.push({
                    action: 'RAISE',
                    player: player.name,
                    raiseAmount: amount,
                    totalBet: player.currentBet,
                    stage: gameState.stage
                });
            }
            
            break;
            
        default:
            return { error: '無效的行動' };
    }

    gameState.roundActions++;
    gameState.actionSequence++;  // 增加行動序號

    // 清除行動計時器
    if (gameState.actionTimer) {
        clearTimeout(gameState.actionTimer);
        gameState.actionTimer = null;
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
    // 先檢查是否還有可以行動的玩家
    const playersCanAct = gameState.players.filter(p => !p.folded && p.chips > 0);
    
    // 如果沒有人能行動（所有人都 all-in 或棄牌），不需要移動
    if (playersCanAct.length === 0) {
        return;
    }
    
    let nextPlayer = (gameState.currentPlayerIdx + 1) % gameState.players.length;
    let count = 0;
    
    // 跳過已棄牌的玩家和已經 all-in（沒籌碼）的玩家
    while ((gameState.players[nextPlayer].folded || gameState.players[nextPlayer].chips === 0) && count < gameState.players.length) {
        nextPlayer = (nextPlayer + 1) % gameState.players.length;
        count++;
    }
    
    // 如果找到了有籌碼的玩家，才設置
    if (!gameState.players[nextPlayer].folded && gameState.players[nextPlayer].chips > 0) {
        gameState.currentPlayerIdx = nextPlayer;
    }
}

// 檢查回合是否完成
function isRoundComplete(gameState) {
    // 未棄牌的玩家
    const activePlayers = gameState.players.filter(p => !p.folded);
    
    // 只剩一個玩家（其他都棄牌）
    if (activePlayers.length === 1) {
        return true;
    }
    
    // 還能行動的玩家（未棄牌且有籌碼）
    const playersWithChips = activePlayers.filter(p => p.chips > 0);
    
    // 所有還能行動的玩家都 all-in 了（只剩 0 或 1 個玩家有籌碼）
    if (playersWithChips.length <= 1) {
        return true;
    }

    const maxBet = Math.max(...gameState.players.map(p => p.currentBet));
    
    // 在翻牌前的第一輪，檢查更嚴格
    if (gameState.stage === 'preflop' && gameState.isFirstRound) {
        // 所有還能行動的玩家必須：
        // 1. 下注金額等於最大下注
        // 2. 已經主動行動過（actedThisRound）
        const allPlayersReady = playersWithChips.every(p => {
            const betMatches = p.currentBet === maxBet;
            return betMatches && p.actedThisRound;
        });
        
        return allPlayersReady;
    } else {
        // 其他情況：所有還能行動的玩家必須下注相同且已行動
        const allPlayersReady = playersWithChips.every(p => {
            const betMatches = p.currentBet === maxBet;
            return betMatches && p.hasActed;
        });
        
        return allPlayersReady;
    }
}

// 進入下一階段
function advanceStage(gameState) {
    const activePlayers = gameState.players.filter(p => !p.folded);
    
    // 只剩一個玩家，直接結算
    if (activePlayers.length === 1) {
        endRound(gameState, activePlayers[0]);
        return;
    }

    // 重置每個玩家的當前下注，但保留總投入
    gameState.players.forEach(p => {
        p.currentBet = 0;
        p.hasActed = false;
        p.actedThisRound = false;  // 新階段重置
        // totalBet 保留不重置
    });
    
    gameState.roundActions = 0;
    gameState.lastRaiseAmount = gameState.bigBlind;
    gameState.isFirstRound = false;  // 不再是第一輪

    // 檢查是否還有玩家能行動
    const playersWithChips = activePlayers.filter(p => p.chips > 0);
    const allPlayersAllIn = playersWithChips.length <= 1;

    // 如果所有人都 all-in，直接發完所有牌到 showdown
    if (allPlayersAllIn) {
        // 清除計時器（沒有玩家需要行動）
        if (gameState.actionTimer) {
            clearTimeout(gameState.actionTimer);
            gameState.actionTimer = null;
        }
        
        // 發完剩餘的牌
        while (gameState.stage !== 'river') {
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
            }
        }
        // 進入 showdown
        gameState.stage = 'showdown';
        const winner = determineWinner(gameState);
        endRound(gameState, winner, activePlayers);
        return;
    }

    // 正常進入下一階段
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
            endRound(gameState, winner, activePlayers);
            return;
    }

    // 從莊家後第一位有籌碼的玩家開始
    let startIdx = (gameState.dealerIdx + 1) % gameState.players.length;
    let foundPlayer = false;
    let attempts = 0;
    
    while (!foundPlayer && attempts < gameState.players.length) {
        const player = gameState.players[startIdx];
        if (!player.folded && player.chips > 0) {
            gameState.currentPlayerIdx = startIdx;
            foundPlayer = true;
        } else {
            startIdx = (startIdx + 1) % gameState.players.length;
            attempts++;
        }
    }
}

// 決定贏家（完整版牌型判斷）
function determineWinner(gameState) {
    const activePlayers = gameState.players.filter(p => !p.folded);
    
    if (activePlayers.length === 1) {
        return activePlayers[0];
    }
    
    // 評估每個玩家的手牌
    const playerHands = activePlayers.map(player => ({
        player,
        handRank: evaluateHand(player.cards, gameState.communityCards)
    }));
    
    // 排序（最強的在前）
    playerHands.sort((a, b) => compareHands(b.handRank, a.handRank));
    
    // 找出所有同樣強度的玩家（平手）
    const winningRank = playerHands[0].handRank;
    const winners = playerHands.filter(ph => compareHands(ph.handRank, winningRank) === 0);
    
    if (winners.length === 1) {
        return winners[0].player;
    }
    
    // 平手 - 返回所有贏家
    return winners.map(w => w.player);
}

// 評估手牌強度
function evaluateHand(holeCards, communityCards) {
    const allCards = [...holeCards, ...communityCards];
    const cards = allCards.map(c => ({
        rank: getRankValue(c.rank),
        suit: c.suit,
        rankStr: c.rank
    }));
    
    // 生成所有可能的 5 張牌組合
    const combinations = getCombinations(cards, 5);
    let bestHand = null;
    
    for (const combo of combinations) {
        const hand = evaluateFiveCards(combo);
        if (!bestHand || compareHands(hand, bestHand) > 0) {
            bestHand = hand;
        }
    }
    
    return bestHand;
}

// 評估 5 張牌
function evaluateFiveCards(cards) {
    const sorted = cards.sort((a, b) => b.rank - a.rank);
    const ranks = sorted.map(c => c.rank);
    const suits = sorted.map(c => c.suit);
    
    const isFlush = suits.every(s => s === suits[0]);
    const straightInfo = checkStraight(ranks);
    const isStraight = straightInfo.isStraight;
    const straightHighCard = straightInfo.highCard;
    
    const rankCounts = {};
    
    ranks.forEach(r => {
        rankCounts[r] = (rankCounts[r] || 0) + 1;
    });
    
    const counts = Object.values(rankCounts).sort((a, b) => b - a);
    const uniqueRanks = Object.keys(rankCounts).map(Number).sort((a, b) => b - a);
    
    // 皇家同花順（A-K-Q-J-10 同花）
    if (isFlush && isStraight && straightHighCard === 14 && ranks.includes(13)) {
        return { type: 9, ranks, tiebreaker: [14] };
    }
    
    // 同花順
    if (isFlush && isStraight) {
        return { type: 8, ranks, tiebreaker: [straightHighCard] };
    }
    
    // 四條
    if (counts[0] === 4) {
        const quad = uniqueRanks.find(r => rankCounts[r] === 4);
        const kicker = uniqueRanks.find(r => rankCounts[r] === 1);
        return { type: 7, ranks, tiebreaker: [quad, kicker] };
    }
    
    // 葫蘆
    if (counts[0] === 3 && counts[1] === 2) {
        const trip = uniqueRanks.find(r => rankCounts[r] === 3);
        const pair = uniqueRanks.find(r => rankCounts[r] === 2);
        return { type: 6, ranks, tiebreaker: [trip, pair] };
    }
    
    // 同花
    if (isFlush) {
        return { type: 5, ranks, tiebreaker: ranks };
    }
    
    // 順子
    if (isStraight) {
        return { type: 4, ranks, tiebreaker: [straightHighCard] };
    }
    
    // 三條
    if (counts[0] === 3) {
        const trip = uniqueRanks.find(r => rankCounts[r] === 3);
        const kickers = uniqueRanks.filter(r => rankCounts[r] === 1).sort((a, b) => b - a);
        return { type: 3, ranks, tiebreaker: [trip, ...kickers] };
    }
    
    // 兩對
    if (counts[0] === 2 && counts[1] === 2) {
        const pairs = uniqueRanks.filter(r => rankCounts[r] === 2).sort((a, b) => b - a);
        const kicker = uniqueRanks.find(r => rankCounts[r] === 1);
        return { type: 2, ranks, tiebreaker: [...pairs, kicker] };
    }
    
    // 一對
    if (counts[0] === 2) {
        const pair = uniqueRanks.find(r => rankCounts[r] === 2);
        const kickers = uniqueRanks.filter(r => rankCounts[r] === 1).sort((a, b) => b - a);
        return { type: 1, ranks, tiebreaker: [pair, ...kickers] };
    }
    
    // 高牌
    return { type: 0, ranks, tiebreaker: ranks };
}

// 檢查順子，返回是否為順子及最高牌
function checkStraight(ranks) {
    const uniqueRanks = [...new Set(ranks)].sort((a, b) => b - a);
    if (uniqueRanks.length < 5) return { isStraight: false, highCard: 0 };
    
    // 一般順子
    for (let i = 0; i < uniqueRanks.length - 4; i++) {
        if (uniqueRanks[i] - uniqueRanks[i + 4] === 4) {
            return { isStraight: true, highCard: uniqueRanks[i] };
        }
    }
    
    // A-2-3-4-5 (輪子) - 最高牌是 5
    if (uniqueRanks.includes(14) && uniqueRanks.includes(5) && 
        uniqueRanks.includes(4) && uniqueRanks.includes(3) && uniqueRanks.includes(2)) {
        return { isStraight: true, highCard: 5 };
    }
    
    return { isStraight: false, highCard: 0 };
}

// 比較兩手牌
function compareHands(hand1, hand2) {
    if (hand1.type !== hand2.type) {
        return hand1.type - hand2.type;
    }
    
    // 同類型，比較 tiebreaker
    for (let i = 0; i < Math.min(hand1.tiebreaker.length, hand2.tiebreaker.length); i++) {
        if (hand1.tiebreaker[i] !== hand2.tiebreaker[i]) {
            return hand1.tiebreaker[i] - hand2.tiebreaker[i];
        }
    }
    
    return 0; // 完全平手
}

// 獲取牌面值
function getRankValue(rank) {
    const values = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
    return values[rank];
}

// 生成組合
function getCombinations(arr, k) {
    if (k === 1) return arr.map(item => [item]);
    const combinations = [];
    for (let i = 0; i < arr.length - k + 1; i++) {
        const head = arr[i];
        const tailCombinations = getCombinations(arr.slice(i + 1), k - 1);
        tailCombinations.forEach(tail => {
            combinations.push([head, ...tail]);
        });
    }
    return combinations;
}

// 計算邊池
function calculateSidePots(gameState) {
    const allPlayers = gameState.players.filter(p => !p.folded);
    
    // 如果只有一個玩家（其他都棄牌），返回主池
    if (allPlayers.length === 1) {
        return [{
            amount: gameState.pot,
            eligiblePlayers: [allPlayers[0].id],
            name: '主池'
        }];
    }
    
    // 收集每個玩家的總投入金額，並按金額排序
    const playerContributions = allPlayers.map(p => ({
        id: p.id,
        name: p.name,
        totalBet: p.totalBet || 0,
        folded: p.folded
    })).sort((a, b) => a.totalBet - b.totalBet);
    
    // 如果沒有人下注，返回空底池
    if (playerContributions.every(p => p.totalBet === 0)) {
        return [{
            amount: 0,
            eligiblePlayers: allPlayers.map(p => p.id),
            name: '主池'
        }];
    }
    
    const pots = [];
    let previousLevel = 0;
    let remainingPlayers = [...allPlayers.map(p => p.id)];
    
    // 找出所有不同的投入級別
    const levels = [...new Set(playerContributions.map(p => p.totalBet))].sort((a, b) => a - b);
    
    levels.forEach((level, idx) => {
        if (level > previousLevel && remainingPlayers.length > 0) {
            // 計算這個級別的底池金額
            const contribution = level - previousLevel;
            const potAmount = contribution * remainingPlayers.length;
            
            if (potAmount > 0) {
                pots.push({
                    amount: potAmount,
                    eligiblePlayers: [...remainingPlayers],
                    name: idx === 0 ? '主池' : `邊池 ${idx}`
                });
            }
        }
        
        // 移除在這個級別投入全部的玩家
        const playersAtThisLevel = playerContributions
            .filter(p => p.totalBet === level)
            .map(p => p.id);
        
        remainingPlayers = remainingPlayers.filter(id => !playersAtThisLevel.includes(id));
        previousLevel = level;
    });
    
    return pots.length > 0 ? pots : [{
        amount: gameState.pot,
        eligiblePlayers: allPlayers.map(p => p.id),
        name: '主池'
    }];
}

// 處理玩家確認結果
function handleConfirmResult(gameState, playerId) {
    if (!gameState.waitingForConfirm) {
        return { error: '遊戲未在等待確認狀態' };
    }
    
    if (!gameState.confirmedPlayers.includes(playerId)) {
        gameState.confirmedPlayers.push(playerId);
    }
    
    // 檢查是否所有玩家都確認了
    const activePlayers = gameState.players.filter(p => p.chips > 0);
    if (gameState.confirmedPlayers.length >= activePlayers.length) {
        // 所有玩家都確認了，開始新回合
        gameState.players.forEach(p => delete p.winAmount);
        delete gameState.winners;
        delete gameState.showdownPlayers;
        delete gameState.waitingForConfirm;
        delete gameState.confirmedPlayers;
        delete gameState.pots;
        
        if (startNewRound(gameState)) {
            return { success: true, newRound: true };
        }
    }
    
    return { success: true, newRound: false };
}

// 獲取牌型名稱
function getHandTypeName(type) {
    const names = ['高牌', '一對', '兩對', '三條', '順子', '同花', '葫蘆', '四條', '同花順', '皇家同花順'];
    return names[type] || '未知';
}

// 結束回合
function endRound(gameState, winners, showdownPlayers = null) {
    // 清除行動計時器
    if (gameState.actionTimer) {
        clearTimeout(gameState.actionTimer);
        gameState.actionTimer = null;
    }
    
    // winners 可能是單一玩家或陣列
    const winnerArray = Array.isArray(winners) ? winners : [winners];
    
    // 計算邊池
    const pots = calculateSidePots(gameState);
    
    // 初始化贏家的獲勝金額
    winnerArray.forEach(winner => {
        winner.winAmount = 0;
    });
    
    pots.forEach(pot => {
        // 找出這個底池的有效玩家中的贏家
        const eligibleWinners = winnerArray.filter(w => 
            pot.eligiblePlayers.includes(w.id)
        );
        
        if (eligibleWinners.length > 0) {
            const share = Math.floor(pot.amount / eligibleWinners.length);
            const remainder = pot.amount % eligibleWinners.length;
            
            // 餘數按莊家後的位置順序分配（更公平）
            const sortedWinners = eligibleWinners.sort((a, b) => {
                const aPos = gameState.players.findIndex(p => p.id === a.id);
                const bPos = gameState.players.findIndex(p => p.id === b.id);
                
                // 計算相對於莊家的位置
                const aRelPos = (aPos - gameState.dealerIdx + gameState.players.length) % gameState.players.length;
                const bRelPos = (bPos - gameState.dealerIdx + gameState.players.length) % gameState.players.length;
                
                return aRelPos - bRelPos;
            });
            
            sortedWinners.forEach((winner, idx) => {
                const winAmount = share + (idx < remainder ? 1 : 0);
                winner.chips += winAmount;
                winner.winAmount = (winner.winAmount || 0) + winAmount;
            });
        }
    });
    
    // 在 showdown 階段，只顯示未棄牌玩家的手牌
    if (showdownPlayers && showdownPlayers.length > 1) {
        gameState.showdownPlayers = showdownPlayers.map(p => ({
            id: p.id,
            name: p.name,
            cards: p.cards,
            handRank: evaluateHand(p.cards, gameState.communityCards)
        }));
    }
    
    gameState.winners = winnerArray.map(w => ({
        id: w.id,
        name: w.name,
        winAmount: w.winAmount
    }));
    
    gameState.pots = pots;
    gameState.waitingForConfirm = true;
    gameState.confirmedPlayers = [];
}

// 廣播遊戲狀態
function broadcastGameState(gameState) {
    const room = Array.from(rooms.values()).find(r => r.gameState === gameState);
    if (!room) return;

    const maxBet = Math.max(...gameState.players.map(p => p.currentBet));

    room.players.forEach(player => {
        const playerState = {
            ...gameState,
            currentPlayer: gameState.players[gameState.currentPlayerIdx]?.id,
            maxBet: maxBet,
            players: gameState.players.map(p => ({
                ...p,
                // 在 showdown 只顯示未棄牌玩家的牌，否則只顯示自己的牌
                cards: (gameState.showdownPlayers && !p.folded) || p.id === player.id ? p.cards : 
                       (p.cards && p.cards.length > 0 ? [{}, {}] : [])
            })),
            // 傳送 showdown 資訊（只包含未棄牌的玩家）
            showdownPlayers: gameState.showdownPlayers,
            winners: gameState.winners,
            pots: gameState.pots,
            waitingForConfirm: gameState.waitingForConfirm,
            confirmedPlayers: gameState.confirmedPlayers,
            hasConfirmed: gameState.confirmedPlayers?.includes(player.id)
        };
        
        if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify({
                type: 'gameUpdate',
                gameState: playerState
            }));
        }
    });
}

// WebSocket 連接
wss.on('connection', (ws) => {
    console.log('New client connected');

    ws.on('message', (message) => {
        try {
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
                case 'confirmResult':
                    handlePlayerConfirmResult(data);
                    break;
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        // 清理斷線的玩家
        rooms.forEach((room, roomId) => {
            const disconnectedPlayer = room.players.find(p => p.ws === ws);
            
            if (disconnectedPlayer) {
                // 從房間移除
                room.players = room.players.filter(p => p.ws !== ws);
                
                // 如果遊戲正在進行，將玩家標記為棄牌
                if (room.gameState) {
                    const gamePlayer = room.gameState.players.find(p => p.id === disconnectedPlayer.id);
                    if (gamePlayer && !gamePlayer.folded) {
                        gamePlayer.folded = true;
                        console.log(`${gamePlayer.name} disconnected and folded`);
                        
                        // 檢查是否需要進入下一階段
                        const activePlayers = room.gameState.players.filter(p => !p.folded);
                        if (activePlayers.length === 1) {
                            // 只剩一人，結束回合
                            endRound(room.gameState, activePlayers[0]);
                            broadcastGameState(room.gameState);
                        } else if (gamePlayer.id === room.gameState.players[room.gameState.currentPlayerIdx]?.id) {
                            // 斷線的是當前玩家，跳到下一位
                            moveToNextPlayer(room.gameState);
                            
                            // 檢查是否回合完成
                            if (isRoundComplete(room.gameState)) {
                                advanceStage(room.gameState);
                            }
                            
                            broadcastGameState(room.gameState);
                        }
                    }
                }
                
                // 如果房間空了，刪除房間
                if (room.players.length === 0) {
                    rooms.delete(roomId);
                }
            }
        });
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
        if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({
                type: 'playerJoined',
                players: room.players.map(pl => ({ id: pl.id, name: pl.name }))
            }));
        }
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
        if (player.ws.readyState === WebSocket.OPEN) {
            const playerState = {
                ...gameState,
                currentPlayer: gameState.players[gameState.currentPlayerIdx]?.id
            };
            player.ws.send(JSON.stringify({
                type: 'gameStarted',
                gameState: playerState
            }));
        }
    });

    broadcastGameState(gameState);
    
    // 為第一個玩家啟動計時器
    startActionTimer(gameState, roomId);
}

// 處理玩家行動
function handlePlayerAction(data) {
    const room = rooms.get(data.roomId);
    if (!room || !room.gameState) return;

    const result = handleAction(room.gameState, data.playerId, data.action, data.amount);
    
    if (result.error) {
        const player = room.players.find(p => p.id === data.playerId);
        if (player && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify({
                type: 'error',
                message: result.error
            }));
        }
        return;
    }

    broadcastGameState(room.gameState);
    
    // 為下一個玩家啟動計時器
    startActionTimer(room.gameState, data.roomId);
}

// 處理玩家確認結果
function handlePlayerConfirmResult(data) {
    const room = rooms.get(data.roomId);
    if (!room || !room.gameState) return;

    const result = handleConfirmResult(room.gameState, data.playerId);
    
    if (result.error) {
        const player = room.players.find(p => p.id === data.playerId);
        if (player && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify({
                type: 'error',
                message: result.error
            }));
        }
        return;
    }

    broadcastGameState(room.gameState);
    
    // 如果開始了新回合，啟動計時器
    if (result.newRound) {
        startActionTimer(room.gameState, data.roomId);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});