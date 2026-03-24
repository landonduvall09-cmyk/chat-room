const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(__dirname));

// Data storage files
const MESSAGES_FILE = path.join(__dirname, 'chat_data.json');
const USERS_FILE = path.join(__dirname, 'users.json');

// Store active users and their socket IDs
const activeUsers = new Map(); // socketId -> { username, currentRoom }
const userSocketMap = new Map(); // username -> socketId

// Store rooms and their members
const rooms = {
    'general': {
        name: 'General Chat',
        type: 'public',
        members: [],
        createdAt: Date.now()
    },
    'random': {
        name: 'Random',
        type: 'public',
        members: [],
        createdAt: Date.now()
    },
    'gaming': {
        name: 'Gaming',
        type: 'public',
        members: [],
        createdAt: Date.now()
    }
};

// Store private conversations
let privateConversations = {}; // { "user1_user2": [messages] }

// Load data from files
function loadData() {
    try {
        if (fs.existsSync(MESSAGES_FILE)) {
            const data = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
            if (data.rooms) Object.assign(rooms, data.rooms);
            if (data.privateConversations) privateConversations = data.privateConversations;
            console.log('✅ Loaded chat data');
        }
    } catch (error) {
        console.error('Error loading data:', error);
    }
}

function saveData() {
    try {
        const data = {
            rooms: rooms,
            privateConversations: privateConversations
        };
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error saving data:', error);
    }
}

// Add message to room history
function addMessageToRoom(roomId, message) {
    if (!rooms[roomId]) return;
    if (!rooms[roomId].messages) rooms[roomId].messages = [];
    rooms[roomId].messages.push(message);
    // Keep last 200 messages per room
    if (rooms[roomId].messages.length > 200) {
        rooms[roomId].messages = rooms[roomId].messages.slice(-200);
    }
    saveData();
}

// Add private message
function addPrivateMessage(conversationId, message) {
    if (!privateConversations[conversationId]) {
        privateConversations[conversationId] = [];
    }
    privateConversations[conversationId].push(message);
    // Keep last 500 messages per private chat
    if (privateConversations[conversationId].length > 500) {
        privateConversations[conversationId] = privateConversations[conversationId].slice(-500);
    }
    saveData();
}

// Get or create private conversation ID
function getPrivateConversationId(user1, user2) {
    return [user1, user2].sort().join('_');
}

// Profanity filter
const badWords = ['fuck', 'shit', 'ass', 'bitch', 'damn', 'crap', 'dick', 'pussy', 'cock', 'whore', 'slut', 'bastard', 'cunt', 'nigga', 'nigger', 'faggot', 'retard', 'motherfucker', 'asshole', 'bullshit'];

function filterProfanity(text) {
    let filteredText = text;
    const regex = new RegExp(`\\b(${badWords.join('|')})\\b`, 'gi');
    filteredText = filteredText.replace(regex, (match) => {
        return '*'.repeat(match.length);
    });
    return filteredText;
}

loadData();

io.on('connection', (socket) => {
    console.log('New user connected:', socket.id);
    let currentUser = null;

    // User joins with username
    socket.on('user-join', (username) => {
        currentUser = username;
        activeUsers.set(socket.id, { username, currentRoom: 'general' });
        userSocketMap.set(username, socket.id);
        
        // Add user to general room by default
        if (!rooms['general'].members.includes(username)) {
            rooms['general'].members.push(username);
        }
        
        // Send available rooms
        socket.emit('rooms-list', Object.keys(rooms).map(roomId => ({
            id: roomId,
            name: rooms[roomId].name,
            type: rooms[roomId].type,
            memberCount: rooms[roomId].members.length
        })));
        
        // Send current room messages
        if (rooms['general'].messages) {
            socket.emit('message-history', rooms['general'].messages);
        }
        
        // Send online users
        io.emit('online-users', Array.from(activeUsers.values()).map(u => u.username));
        
        // Broadcast join message
        const joinMessage = {
            text: `${username} joined the chat!`,
            username: 'System',
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now(),
            isSystem: true
        };
        addMessageToRoom('general', joinMessage);
        io.to('general').emit('message', joinMessage);
        
        // Update room member lists
        updateRoomMemberLists();
    });
    
    // Switch room
    socket.on('switch-room', (roomId) => {
        const userData = activeUsers.get(socket.id);
        if (!userData) return;
        
        const oldRoom = userData.currentRoom;
        userData.currentRoom = roomId;
        activeUsers.set(socket.id, userData);
        
        // Join new room socket room
        socket.join(roomId);
        if (oldRoom) socket.leave(oldRoom);
        
        // Send room messages
        if (rooms[roomId] && rooms[roomId].messages) {
            socket.emit('message-history', rooms[roomId].messages);
        } else {
            socket.emit('message-history', []);
        }
        
        // Notify about room switch
        socket.emit('room-switched', { roomId, roomName: rooms[roomId].name });
    });
    
    // Create new group
    socket.on('create-group', (groupName) => {
        if (!currentUser) return;
        
        const groupId = groupName.toLowerCase().replace(/\s+/g, '-');
        if (!rooms[groupId]) {
            rooms[groupId] = {
                name: groupName,
                type: 'group',
                creator: currentUser,
                members: [currentUser],
                messages: [],
                createdAt: Date.now()
            };
            saveData();
            
            // Notify all users about new room
            io.emit('new-room', {
                id: groupId,
                name: groupName,
                type: 'group',
                memberCount: 1
            });
            
            socket.emit('group-created', { id: groupId, name: groupName });
        } else {
            socket.emit('error', 'Group already exists!');
        }
    });
    
    // Invite to group
    socket.on('invite-to-group', ({ groupId, targetUsername }) => {
        if (!rooms[groupId]) return;
        
        const targetSocketId = userSocketMap.get(targetUsername);
        if (targetSocketId) {
            io.to(targetSocketId).emit('group-invite', {
                groupId: groupId,
                groupName: rooms[groupId].name,
                inviter: currentUser
            });
        }
    });
    
    // Accept group invite
    socket.on('accept-invite', ({ groupId }) => {
        if (rooms[groupId] && !rooms[groupId].members.includes(currentUser)) {
            rooms[groupId].members.push(currentUser);
            saveData();
            
            socket.join(groupId);
            
            const joinMessage = {
                text: `${currentUser} joined the group!`,
                username: 'System',
                time: new Date().toLocaleTimeString(),
                timestamp: Date.now(),
                isSystem: true
            };
            addMessageToRoom(groupId, joinMessage);
            io.to(groupId).emit('message', joinMessage);
            
            updateRoomMemberLists();
        }
    });
    
    // Send public message to current room
    socket.on('send-message', (messageData) => {
        const userData = activeUsers.get(socket.id);
        if (!userData) return;
        
        const username = userData.username;
        const currentRoom = userData.currentRoom;
        
        let messageText = filterProfanity(messageData.text);
        const wasFiltered = messageText !== messageData.text;
        
        const message = {
            text: messageText,
            username: username,
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now(),
            isSystem: false,
            wasFiltered: wasFiltered
        };
        
        addMessageToRoom(currentRoom, message);
        io.to(currentRoom).emit('message', message);
    });
    
    // Send private message
    socket.on('send-private', ({ targetUsername, text }) => {
        if (!currentUser) return;
        
        const conversationId = getPrivateConversationId(currentUser, targetUsername);
        let messageText = filterProfanity(text);
        const wasFiltered = messageText !== text;
        
        const message = {
            text: messageText,
            username: currentUser,
            targetUsername: targetUsername,
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now(),
            isPrivate: true,
            wasFiltered: wasFiltered
        };
        
        addPrivateMessage(conversationId, message);
        
        // Send to both users
        const senderSocket = socket.id;
        const targetSocketId = userSocketMap.get(targetUsername);
        
        if (targetSocketId) {
            io.to(targetSocketId).emit('private-message', message);
        }
        socket.emit('private-message', message);
    });
    
    // Get private chat history
    socket.on('get-private-history', (targetUsername) => {
        if (!currentUser) return;
        const conversationId = getPrivateConversationId(currentUser, targetUsername);
        const history = privateConversations[conversationId] || [];
        socket.emit('private-history', { targetUsername, messages: history });
    });
    
    // Send image
    socket.on('send-image', (imageData) => {
        const userData = activeUsers.get(socket.id);
        if (!userData) return;
        
        const imageMessage = {
            image: imageData.image,
            username: userData.username,
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now(),
            isSystem: false,
            isImage: true
        };
        
        if (imageData.isPrivate && imageData.targetUsername) {
            // Private image
            const conversationId = getPrivateConversationId(userData.username, imageData.targetUsername);
            addPrivateMessage(conversationId, imageMessage);
            
            const targetSocketId = userSocketMap.get(imageData.targetUsername);
            if (targetSocketId) {
                io.to(targetSocketId).emit('private-message', imageMessage);
            }
            socket.emit('private-message', imageMessage);
        } else {
            // Public image in current room
            const currentRoom = userData.currentRoom;
            addMessageToRoom(currentRoom, imageMessage);
            io.to(currentRoom).emit('message', imageMessage);
        }
    });
    
    // Typing indicator
    socket.on('typing', ({ isTyping, targetUsername, isPrivate }) => {
        const userData = activeUsers.get(socket.id);
        if (!userData) return;
        
        if (isPrivate && targetUsername) {
            const targetSocketId = userSocketMap.get(targetUsername);
            if (targetSocketId) {
                io.to(targetSocketId).emit('user-typing', {
                    username: userData.username,
                    isTyping: isTyping,
                    isPrivate: true
                });
            }
        } else {
            const currentRoom = userData.currentRoom;
            socket.to(currentRoom).emit('user-typing', {
                username: userData.username,
                isTyping: isTyping
            });
        }
    });
    
    // Disconnect
    socket.on('disconnect', () => {
        if (currentUser) {
            // Remove user from all rooms
            Object.keys(rooms).forEach(roomId => {
                const index = rooms[roomId].members.indexOf(currentUser);
                if (index !== -1) rooms[roomId].members.splice(index, 1);
            });
            
            activeUsers.delete(socket.id);
            userSocketMap.delete(currentUser);
            
            const leaveMessage = {
                text: `${currentUser} left the chat`,
                username: 'System',
                time: new Date().toLocaleTimeString(),
                timestamp: Date.now(),
                isSystem: true
            };
            addMessageToRoom('general', leaveMessage);
            io.to('general').emit('message', leaveMessage);
            
            io.emit('online-users', Array.from(activeUsers.values()).map(u => u.username));
            updateRoomMemberLists();
        }
        console.log('User disconnected:', socket.id);
    });
    
    function updateRoomMemberLists() {
        const roomMembers = {};
        Object.keys(rooms).forEach(roomId => {
            roomMembers[roomId] = rooms[roomId].members;
        });
        io.emit('room-members', roomMembers);
    }
});

// Clear history endpoint
app.post('/clear-history', (req, res) => {
    try {
        Object.keys(rooms).forEach(roomId => {
            rooms[roomId].messages = [];
        });
        privateConversations = {};
        saveData();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Enhanced Chat Server running on http://localhost:${PORT}`);
    console.log(`📝 Groups and Private Chats ENABLED`);
    console.log(`🔞 Profanity Filter ACTIVE`);
    console.log(`🖼️ Image Upload SUPPORTED`);
});
