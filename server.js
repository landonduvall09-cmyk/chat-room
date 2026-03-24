const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files from current directory
app.use(express.static(__dirname));

// File to store messages
const MESSAGES_FILE = path.join(__dirname, 'chat_history.json');

// Store active users
const users = {};

// Profanity filter - list of bad words
const badWords = [
    'fuck', 'shit', 'ass', 'bitch', 'damn', 'crap', 'dick', 'pussy',
    'cock', 'whore', 'slut', 'bastard', 'cunt', 'nigga', 'nigger',
    'faggot', 'retard', 'motherfucker', 'asshole', 'bullshit'
];

// Function to filter profanity
function filterProfanity(text) {
    let filteredText = text;
    const regex = new RegExp(`\\b(${badWords.join('|')})\\b`, 'gi');
    filteredText = filteredText.replace(regex, (match) => {
        return '*'.repeat(match.length);
    });
    return filteredText;
}

// Load previous messages from file
let messageHistory = [];

function loadMessageHistory() {
    try {
        if (fs.existsSync(MESSAGES_FILE)) {
            const data = fs.readFileSync(MESSAGES_FILE, 'utf8');
            messageHistory = JSON.parse(data);
            console.log(`Loaded ${messageHistory.length} messages from history`);
        } else {
            messageHistory = [];
            saveMessageHistory();
            console.log('Created new chat history file');
        }
    } catch (error) {
        console.error('Error loading message history:', error);
        messageHistory = [];
    }
}

function saveMessageHistory() {
    try {
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messageHistory, null, 2));
    } catch (error) {
        console.error('Error saving message history:', error);
    }
}

// Add message to history
function addMessageToHistory(message) {
    messageHistory.push(message);
    if (messageHistory.length > 500) {
        messageHistory = messageHistory.slice(-500);
    }
    saveMessageHistory();
}

// Load history on startup
loadMessageHistory();

io.on('connection', (socket) => {
    console.log('New user connected:', socket.id);

    // Send message history to new user
    socket.emit('message-history', messageHistory);

    // When a new user joins
    socket.on('user-join', (username) => {
        users[socket.id] = username;
        
        const joinMessage = {
            text: `${username} joined the chat!`,
            username: 'System',
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now(),
            isSystem: true
        };
        
        socket.broadcast.emit('message', joinMessage);
        addMessageToHistory(joinMessage);
        
        io.emit('user-list', Object.values(users));
    });

    // When a user sends a message
    socket.on('send-message', (messageData) => {
        const username = users[socket.id] || 'Anonymous';
        
        let messageText = messageData.text;
        let wasFiltered = false;
        
        // Check if message contains profanity
        const originalText = messageText;
        messageText = filterProfanity(messageText);
        
        if (originalText !== messageText) {
            wasFiltered = true;
        }
        
        const message = {
            text: messageText,
            username: username,
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now(),
            isSystem: false,
            wasFiltered: wasFiltered
        };
        
        io.emit('message', message);
        addMessageToHistory(message);
    });
    
    // When a user sends an image
    socket.on('send-image', (imageData) => {
        const username = users[socket.id] || 'Anonymous';
        
        const imageMessage = {
            image: imageData.image,
            username: username,
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now(),
            isSystem: false,
            isImage: true
        };
        
        io.emit('message', imageMessage);
        addMessageToHistory(imageMessage);
    });

    // When a user is typing
    socket.on('typing', (isTyping) => {
        const username = users[socket.id];
        if (username) {
            socket.broadcast.emit('user-typing', {
                username: username,
                isTyping: isTyping
            });
        }
    });

    // When a user disconnects
    socket.on('disconnect', () => {
        const username = users[socket.id];
        if (username) {
            delete users[socket.id];
            
            const leaveMessage = {
                text: `${username} left the chat`,
                username: 'System',
                time: new Date().toLocaleTimeString(),
                timestamp: Date.now(),
                isSystem: true
            };
            
            io.emit('message', leaveMessage);
            addMessageToHistory(leaveMessage);
            io.emit('user-list', Object.values(users));
        }
        console.log('User disconnected:', socket.id);
    });
});

// Clear chat history endpoint
app.post('/clear-history', (req, res) => {
    try {
        messageHistory = [];
        saveMessageHistory();
        res.json({ success: true, message: 'Chat history cleared' });
        console.log('Chat history cleared by admin');
    } catch (error) {
        console.error('Error clearing history:', error);
        res.status(500).json({ success: false, error: 'Failed to clear history' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Chat server running on http://localhost:${PORT}`);
    console.log(`📝 Messages are saved to ${MESSAGES_FILE}`);
    console.log(`🔞 Profanity filter is ACTIVE`);
    console.log(`🖼️ Image upload support ENABLED`);
    console.log(`Share this URL with friends on the same network!`);
});
