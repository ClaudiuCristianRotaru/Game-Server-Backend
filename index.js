const httpServer = require('http').createServer();
const io = require('socket.io')(httpServer, {
    cors: {
        origin: ["http://localhost:4200", "http://192.168.1.2:4200", "192.168.1.2:4200"]
    }
})
const axios = require('axios').default
var querystring = require('querystring');
const http = require('http');
const crypto = require('crypto');

let queue = [];

io.on("connection", socket => {
    console.log(socket.id)

    socket.on("checkexisting", (params, callback) => {
        socketExistingGame = checkUidInGame(params.userId);
        if (socketExistingGame) {
            console.log('found game');
            callback(socketExistingGame);
        }
    })

    socket.on("joinqueue", (params, callback) => {
        if (checkUidInQueue(params.userId) == true) return;
        queue.push({ id: socket.id, rating: params.rating, ratingOffset: 10, uid: params.userId });
        console.log(queue);
        callback({ queueLength: queue.length })
    })

    socket.on("join-room", (params, callback) => {
        console.log(socket.id + " joined " + params.room);
        socket.join(params.room);
        if (!rooms.get(params.room)) {
            console.log("skipping");
            return
        };
        let clr = "spectator";
        if (rooms.get(params.room).whiteId == params.uid) {
            clr = "white";
        }
        if (rooms.get(params.room).blackId == params.uid) {
            clr = "black";
        }
        console.log(rooms.get(params.room));
        callback({ color: clr, room: rooms.get(params.room)});
    })

    socket.on("disconnect", reason => {
        removeQueue(socket.id);
        console.log(reason);
    })

    socket.on("make move", params => {
        if (!params.room) return;
        rooms.get(params.room).FEN = params.FEN;
        rooms.get(params.room).pastPositions = params.pastPositions;
        socket.to(params.room).emit("new move", params);
    })

    socket.on("leavequeue", params => {
        console.log("leaving")
        removeQueue(socket.id);
    })

    socket.on("gameend", params => {
        if (!params.room) return;
        rooms.get(params.room).pastPositions.push(rooms.get(params.room).FEN);
        io.to(params.room).emit("gameended", params);
        console.log({
            id: params.room,
            result: params.status.result,
            FENS: JSON.stringify(rooms.get(params.room).pastPositions),
            chat_logs: JSON.stringify(rooms.get(params.room).chat_logs),
            white_id: rooms.get(params.room).whiteId,
            black_id: rooms.get(params.room).blackId,
        });
        axios.post("http://localhost:3000/game",
            {
                id: params.room,
                result: params.status.result,
                FENS: JSON.stringify(rooms.get(params.room).pastPositions),
                chat_logs: JSON.stringify(rooms.get(params.room).chat_logs),
                white_id: rooms.get(params.room).whiteId,
                black_id: rooms.get(params.room).blackId,
            });
        updateRatings(rooms.get(params.room).whiteId,rooms.get(params.room).blackId, params.status.result);
    })

    socket.on("send-message", params => {
        console.log(params);
        rooms.get(params.room).chat_logs.push({author: params.author, content: params.content});
        socket.to(params.room).emit("receive-message", params);
    })

    socket.on("offer-draw", params => {
        console.log(params);
        socket.to(params.room).emit("draw-offered");
    })

})

const matchmakeInterval = setInterval(findPairs, 5000);

let rooms = new Map();

function checkUidInQueue(uid) {
    let found = false;
    queue.forEach(user => {
        if (user.uid == uid)
            found = true;
    })
    return found;
}

function removeQueue(socketId) {
    for (let i = 0; i < queue.length; i++) {
        if (queue[i].id == socketId) {
            queue.splice(i, 1);
            console.log("removed from queue " + socketId);
        }
    }
}

function checkUidInGame(uid) {
    let roomResult;
    rooms.forEach(room => {
        if (room.whiteId == uid || room.blackId == uid) {
            roomResult = room;
        }
    })
    return roomResult;
}

async function updateRatings(white_id, black_id, result) {

    let white_player = (await axios.get(`http://localhost:3000/user/id/${white_id}`)).data;
    let black_player = (await axios.get(`http://localhost:3000/user/id/${black_id}`)).data;

    probabilityWhiteWin = 1 / ( 1 + Math.pow(10,((black_player.rating - white_player.rating)/400)));
    probabilityBlackWin = 1 - probabilityWhiteWin;

    let res = 0.5;
    switch (result) {
        case "White win": res = 1; break;
        case "Draw": res = 0.5; break;
        case "Black win": res = 0; break;
    }
    let newWhiteRating = white_player.rating + 20*(res - probabilityWhiteWin);
    let newBlackRating = black_player.rating + 20*((1-res) - probabilityBlackWin);

    await axios.patch(`http://localhost:3000/user/id/${white_id}`,{
        id: white_id,
        rating: Math.round(newWhiteRating)
    })

    await axios.patch(`http://localhost:3000/user/id/${black_id}`,{
        id: black_id,
        rating: Math.round(newBlackRating)
    })
}

function findPairs() {
    if (queue.length == 0) return;
    for (let i = 0; i < queue.length; i++) {
        for (let j = i + 1; j < queue.length; j++) {
            console.log(`Comparing ${i}.${queue[i].id} to ${j}.${queue[j].id}`);
            if (Math.abs(queue[i].rating - queue[j].rating) < Math.min(queue[i].ratingOffset, queue[j].ratingOffset)) {
                let id = crypto.randomUUID();
                console.log(`Matching ${i}.${queue[i]} to ${j}.${queue[j]}`);
                let startingFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
                if (Math.random() > 0.5) {
                    rooms.set(id, { id: id, whiteId: queue[i].uid, blackId: queue[j].uid, FEN: startingFEN, pastPositions: [], isOngoing: true, chat_logs: [] });
                    io.to(queue[i].id).emit("new match", { roomId: id, opponentId: queue[j].uid, playingWhite: true });
                    io.to(queue[j].id).emit("new match", { roomId: id, opponentId: queue[i].uid, playingWhite: false });
                } else {
                    rooms.set(id, { id: id, whiteId: queue[j].uid, blackId: queue[i].uid, FEN: startingFEN, pastPositions: [], isOngoing: true, chat_logs: [] });
                    io.to(queue[i].id).emit("new match", { roomId: id, opponentId: queue[j].uid, playingWhite: false });
                    io.to(queue[j].id).emit("new match", { roomId: id, opponentId: queue[i].uid, playingWhite: true });
                }
            }
        }
        if (queue[i])
            queue[i].ratingOffset += 10;
    }
    //console.log(rooms);
}

httpServer.listen(2112, "192.168.1.2");