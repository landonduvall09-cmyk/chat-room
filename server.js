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
const STUDY_DATA_FILE = path.join(__dirname, 'study_data.json');
const OFFLINE_MESSAGES_FILE = path.join(__dirname, 'offline_messages.json');

// Store active users
const activeUsers = new Map(); // socketId -> { username, currentRoom }
const userSocketMap = new Map(); // username -> socketId

// Store offline messages
let offlineMessages = {}; // { username: [messages] }

// Store study groups
let studyGroups = {
    'general-study': {
        name: 'General Study Hall',
        subject: 'All Subjects',
        description: 'Collaborate on any subject',
        type: 'public',
        members: [],
        messages: [],
        createdAt: Date.now()
    },
    'math-help': {
        name: 'Math Help Center',
        subject: 'Mathematics',
        description: 'Algebra, Calculus, Geometry help',
        type: 'public',
        members: [],
        messages: [],
        createdAt: Date.now()
    },
    'science-lab': {
        name: 'Science Lab',
        subject: 'Sciences',
        description: 'Biology, Chemistry, Physics',
        type: 'public',
        members: [],
        messages: [],
        createdAt: Date.now()
    },
    'writing-center': {
        name: 'Writing Center',
        subject: 'English & Writing',
        description: 'Essays, papers, creative writing',
        type: 'public',
        members: [],
        messages: [],
        createdAt: Date.now()
    }
};

// Store private conversations
let privateMessages = {}; // { "user1_user2": [messages] }

// Store all users who have ever joined
let allUsers = new Set(); // Track all users who have ever joined

// Load data
function loadData() {
    try {
        if (fs.existsSync(STUDY_DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(STUDY_DATA_FILE, 'utf8'));
            if (data.studyGroups) Object.assign(studyGroups, data.studyGroups);
            if (data.privateMessages) privateMessages = data.privateMessages;
            if (data.allUsers) allUsers = new Set(data.allUsers);
            console.log('✅ Loaded study data');
        }
        
        if (fs.existsSync(OFFLINE_MESSAGES_FILE)) {
            offlineMessages = JSON.parse(fs.readFileSync(OFFLINE_MESSAGES_FILE, 'utf8'));
            console.log('✅ Loaded offline messages');
        }
    } catch (error) {
        console.error('Error loading data:', error);
    }
}

function saveData() {
    try {
        const data = {
            studyGroups: studyGroups,
            privateMessages: privateMessages,
            allUsers: Array.from(allUsers)
        };
        fs.writeFileSync(STUDY_DATA_FILE, JSON.stringify(data, null, 2));
        
        fs.writeFileSync(OFFLINE_MESSAGES_FILE, JSON.stringify(offlineMessages, null, 2));
    } catch (error) {
        console.error('Error saving data:', error);
    }
}

// Add message to group
function addMessageToGroup(groupId, message) {
    if (!studyGroups[groupId]) return;
    if (!studyGroups[groupId].messages) studyGroups[groupId].messages = [];
    studyGroups[groupId].messages.push(message);
    if (studyGroups[groupId].messages.length > 500) {
        studyGroups[groupId].messages = studyGroups[groupId].messages.slice(-500);
    }
    saveData();
}

// Delete message from group (any user can delete)
function deleteMessageFromGroup(groupId, messageId, requester) {
    if (studyGroups[groupId] && studyGroups[groupId].messages) {
        const messageIndex = studyGroups[groupId].messages.findIndex(m => m.id === messageId);
        if (messageIndex !== -1) {
            const message = studyGroups[groupId].messages[messageIndex];
            // Anyone can delete any message now
            studyGroups[groupId].messages.splice(messageIndex, 1);
            saveData();
            return true;
        }
    }
    return false;
}

// Add private message
function addPrivateMessage(conversationId, message) {
    if (!privateMessages[conversationId]) {
        privateMessages[conversationId] = [];
    }
    privateMessages[conversationId].push(message);
    if (privateMessages[conversationId].length > 500) {
        privateMessages[conversationId] = privateMessages[conversationId].slice(-500);
    }
    saveData();
}

// Delete private message (anyone can delete)
function deletePrivateMessage(conversationId, messageId, requester) {
    if (privateMessages[conversationId]) {
        const messageIndex = privateMessages[conversationId].findIndex(m => m.id === messageId);
        if (messageIndex !== -1) {
            privateMessages[conversationId].splice(messageIndex, 1);
            saveData();
            return true;
        }
    }
    return false;
}

// Store offline message
function storeOfflineMessage(username, message) {
    if (!offlineMessages[username]) {
        offlineMessages[username] = [];
    }
    offlineMessages[username].push(message);
    if (offlineMessages[username].length > 100) {
        offlineMessages[username] = offlineMessages[username].slice(-100);
    }
    saveData();
}

// Get offline messages for user
function getOfflineMessages(username) {
    const messages = offlineMessages[username] || [];
    delete offlineMessages[username];
    saveData();
    return messages;
}

// Get private conversation ID
function getPrivateConversationId(user1, user2) {
    return [user1, user2].sort().join('_');
}

// Generate unique message ID
function generateMessageId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Educational profanity filter
const inappropriateWords = ['fuck', 'shit', 'ass', 'bitch', 'damn', 'crap', 'dick', 'pussy', 'cock', 'whore', 'slut', 'bastard', 'cunt', 'nigga', 'nigger', 'faggot', 'retard', 'motherfucker', 'asshole', 'bullshit', 'sex', 'porn'];

function filterInappropriate(text) {
    let filteredText = text;
    const regex = new RegExp(`\\b(${inappropriateWords.join('|')})\\b`, 'gi');
    filteredText = filteredText.replace(regex, (match) => {
        return '[content removed]';
    });
    return filteredText;
}

loadData();

io.on('connection', (socket) => {
    console.log('Student connected:', socket.id);
    let currentUser = null;

    // Student joins
    socket.on('student-join', (username) => {
        currentUser = username;
        activeUsers.set(socket.id, { username, currentRoom: 'general-study' });
        userSocketMap.set(username, socket.id);
        
        // Add to all users set
        allUsers.add(username);
        
        if (!studyGroups['general-study'].members.includes(username)) {
            studyGroups['general-study'].members.push(username);
        }
        
        // Send available study groups
        socket.emit('study-groups', Object.keys(studyGroups).map(groupId => ({
            id: groupId,
            name: studyGroups[groupId].name,
            subject: studyGroups[groupId].subject,
            description: studyGroups[groupId].description,
            type: studyGroups[groupId].type,
            memberCount: studyGroups[groupId].members.length
        })));
        
        // Send current group messages
        if (studyGroups['general-study'].messages) {
            socket.emit('message-history', studyGroups['general-study'].messages);
        }
        
        // Send all users who have ever joined
        socket.emit('all-users', Array.from(allUsers).filter(u => u !== username));
        
        // Send online students
        io.emit('online-students', Array.from(activeUsers.values()).map(u => u.username));
        
        // Send offline messages to this user
        const offlineMsgs = getOfflineMessages(username);
        if (offlineMsgs.length > 0) {
            socket.emit('offline-messages', offlineMsgs);
        }
        
        // Broadcast join message
        const joinMessage = {
            id: generateMessageId(),
            text: `${username} joined the study session!`,
            username: 'System',
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now(),
            isSystem: true
        };
        addMessageToGroup('general-study', joinMessage);
        io.to('general-study').emit('message', joinMessage);
        
        updateGroupMemberLists();
        saveData();
    });
    
    // Get all previous users
    socket.on('get-all-users', () => {
        socket.emit('all-users', Array.from(allUsers).filter(u => u !== currentUser));
    });
    
    // Switch study group
    socket.on('switch-group', (groupId) => {
        const userData = activeUsers.get(socket.id);
        if (!userData) return;
        
        const oldGroup = userData.currentRoom;
        userData.currentRoom = groupId;
        activeUsers.set(socket.id, userData);
        
        socket.join(groupId);
        if (oldGroup) socket.leave(oldGroup);
        
        if (studyGroups[groupId] && studyGroups[groupId].messages) {
            socket.emit('message-history', studyGroups[groupId].messages);
        } else {
            socket.emit('message-history', []);
        }
        
        socket.emit('group-switched', { 
            groupId: groupId, 
            groupName: studyGroups[groupId].name 
        });
    });
    
    // Send message to group
    socket.on('send-message', (messageData) => {
        const userData = activeUsers.get(socket.id);
        if (!userData) return;
        
        const username = userData.username;
        const currentGroup = userData.currentRoom;
        
        let messageText = filterInappropriate(messageData.text);
        const wasFiltered = messageText !== messageData.text;
        
        const message = {
            id: generateMessageId(),
            text: messageText,
            username: username,
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now(),
            isSystem: false,
            wasFiltered: wasFiltered
        };
        
        addMessageToGroup(currentGroup, message);
        io.to(currentGroup).emit('message', message);
    });
    
    // Send private message (with offline support)
    socket.on('send-private', ({ targetUsername, text }) => {
        if (!currentUser) return;
        
        const conversationId = getPrivateConversationId(currentUser, targetUsername);
        let messageText = filterInappropriate(text);
        const wasFiltered = messageText !== text;
        
        const message = {
            id: generateMessageId(),
            text: messageText,
            username: currentUser,
            targetUsername: targetUsername,
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now(),
            isPrivate: true,
            wasFiltered: wasFiltered
        };
        
        addPrivateMessage(conversationId, message);
        
        const targetSocketId = userSocketMap.get(targetUsername);
        if (targetSocketId) {
            // User is online, send immediately
            io.to(targetSocketId).emit('private-message', message);
        } else {
            // User is offline, store message
            storeOfflineMessage(targetUsername, message);
        }
        socket.emit('private-message', message);
    });
    
    // Delete any message (anyone can delete)
    socket.on('delete-message', ({ messageId, isPrivate, targetUsername, groupId }) => {
        if (!currentUser) return;
        
        let success = false;
        
        if (isPrivate && targetUsername) {
            const conversationId = getPrivateConversationId(currentUser, targetUsername);
            success = deletePrivateMessage(conversationId, messageId, currentUser);
            if (success) {
                const targetSocketId = userSocketMap.get(targetUsername);
                if (targetSocketId) {
                    io.to(targetSocketId).emit('message-deleted', { messageId, isPrivate: true });
                }
                socket.emit('message-deleted', { messageId, isPrivate: true });
            }
        } else {
            const currentGroup = groupId || (activeUsers.get(socket.id)?.currentRoom);
            if (currentGroup) {
                success = deleteMessageFromGroup(currentGroup, messageId, currentUser);
                if (success) {
                    io.to(currentGroup).emit('message-deleted', { messageId, isPrivate: false });
                }
            }
        }
    });
    
    // Delete entire chat history for a private conversation
    socket.on('delete-private-chat', ({ targetUsername }) => {
        if (!currentUser) return;
        const conversationId = getPrivateConversationId(currentUser, targetUsername);
        if (privateMessages[conversationId]) {
            delete privateMessages[conversationId];
            saveData();
            socket.emit('chat-deleted', { targetUsername });
            const targetSocketId = userSocketMap.get(targetUsername);
            if (targetSocketId) {
                io.to(targetSocketId).emit('chat-deleted', { targetUsername: currentUser });
            }
        }
    });
    
    // Get private chat history
    socket.on('get-private-history', (targetUsername) => {
        if (!currentUser) return;
        const conversationId = getPrivateConversationId(currentUser, targetUsername);
        const history = privateMessages[conversationId] || [];
        socket.emit('private-history', { targetUsername, messages: history });
    });
    
    // Send image
    socket.on('send-image', (imageData) => {
        const userData = activeUsers.get(socket.id);
        if (!userData) return;
        
        const imageMessage = {
            id: generateMessageId(),
            image: imageData.image,
            username: userData.username,
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now(),
            isSystem: false,
            isImage: true
        };
        
        if (imageData.isPrivate && imageData.targetUsername) {
            const conversationId = getPrivateConversationId(userData.username, imageData.targetUsername);
            addPrivateMessage(conversationId, imageMessage);
            const targetSocketId = userSocketMap.get(imageData.targetUsername);
            if (targetSocketId) {
                io.to(targetSocketId).emit('private-message', imageMessage);
            } else {
                storeOfflineMessage(imageData.targetUsername, imageMessage);
            }
            socket.emit('private-message', imageMessage);
        } else {
            const currentGroup = userData.currentRoom;
            addMessageToGroup(currentGroup, imageMessage);
            io.to(currentGroup).emit('message', imageMessage);
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
            const currentGroup = userData.currentRoom;
            socket.to(currentGroup).emit('user-typing', {
                username: userData.username,
                isTyping: isTyping
            });
        }
    });
    
    // Disconnect
    socket.on('disconnect', () => {
        if (currentUser) {
            Object.keys(studyGroups).forEach(groupId => {
                const index = studyGroups[groupId].members.indexOf(currentUser);
                if (index !== -1) studyGroups[groupId].members.splice(index, 1);
            });
            
            activeUsers.delete(socket.id);
            userSocketMap.delete(currentUser);
            
            const leaveMessage = {
                id: generateMessageId(),
                text: `${currentUser} left the study session`,
                username: 'System',
                time: new Date().toLocaleTimeString(),
                timestamp: Date.now(),
                isSystem: true
            };
            addMessageToGroup('general-study', leaveMessage);
            io.to('general-study').emit('message', leaveMessage);
            
            io.emit('online-students', Array.from(activeUsers.values()).map(u => u.username));
            updateGroupMemberLists();
            saveData();
        }
        console.log('Student disconnected:', socket.id);
    });
    
    function updateGroupMemberLists() {
        const groupMembers = {};
        Object.keys(studyGroups).forEach(groupId => {
            groupMembers[groupId] = studyGroups[groupId].members;
        });
        io.emit('group-members', groupMembers);
    }
});

// Clear history endpoint
app.post('/clear-history', (req, res) => {
    try {
        Object.keys(studyGroups).forEach(groupId => {
            studyGroups[groupId].messages = [];
        });
        privateMessages = {};
        offlineMessages = {};
        saveData();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`📚 Study Group Hub running on http://localhost:${PORT}`);
    console.log(`💬 Private Messages with Offline Support`);
    console.log(`🗑️ Anyone Can Delete Any Message`);
    console.log(`📨 Offline Messages Delivered When User Returns`);
    console.log(`👥 All Previous Users Can Be Messaged`);
});
