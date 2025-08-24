import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, query, orderBy, onSnapshot, addDoc, updateDoc, deleteDoc, doc } from 'firebase/firestore';
import { Bell, MessageSquare, Plus, Trash2, CheckCircle, CircleDot, Clock, Send, X, Mic, StopCircle } from 'lucide-react'; // Added Mic and StopCircle icons

// Firebase configuration (provided by the environment)
// For local development, these should be replaced with actual Firebase config values
// If running in Canvas, __firebase_config, __app_id, and __initial_auth_token are provided.
// If running locally, you need to provide your own Firebase config and API keys.
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
    apiKey: "AIzaSyAJKEEUxFunP8jSSBdQNa8iPK_NOX8tcFI", // Replace with your Firebase API Key for local testing
    authDomain: "project-22e46.firebaseapp.com", // Replace with your Auth Domain
    projectId: "project-22e46", // Replace with your Project ID
    storageBucket: "project-22e46.firebasestorage.app", // Replace with your Storage Bucket
    messagingSenderId: "341665681835", // Replace with your Messaging Sender ID
    appId: "1:341665681835:web:f5280c6bc62101b5e142ee",
  measurementId: "G-4DFCQXGWSX" // Replace with your Firebase App ID
};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Default for local, or Canvas value
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null; // Null for local, or Canvas value

// Utility function for exponential backoff
const exponentialBackoff = async (func, retries = 5, delay = 1000) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await func();
        } catch (error) {
            if (i === retries - 1) throw error;
            await new Promise(res => setTimeout(res, delay * Math.pow(2, i)));
        }
    }
};

// Helper to convert base64 to ArrayBuffer for audio
const base64ToArrayBuffer = (base64) => {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
};

// Helper to convert PCM to WAV (signed 16-bit, 44.1kHz)
const pcmToWav = (pcmData, sampleRate) => {
    const numChannels = 1;
    const bytesPerSample = 2; // 16-bit
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;

    const dataLength = pcmData.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    // RIFF identifier
    writeString(view, 0, 'RIFF');
    // File size (data + 36)
    view.setUint32(4, 36 + dataLength, true);
    // Format
    writeString(view, 8, 'WAVE');
    // Format chunk identifier
    writeString(view, 12, 'fmt ');
    // Format chunk length
    view.setUint32(16, 16, true);
    // Audio format (PCM = 1)
    view.setUint16(20, 1, true);
    // Number of channels
    view.setUint16(22, numChannels, true);
    // Sample rate
    view.setUint32(24, sampleRate, true);
    // Byte rate
    view.setUint32(28, byteRate, true);
    // Block align
    view.setUint16(32, blockAlign, true);
    // Bits per sample
    view.setUint16(34, bytesPerSample * 8, true);
    // Data chunk identifier
    writeString(view, 36, 'data');
    // Data chunk length
    view.setUint32(40, dataLength, true);

    // Write PCM data
    let offset = 44;
    for (let i = 0; i < pcmData.length; i++) {
        view.setInt16(offset, pcmData[i], true);
        offset += bytesPerSample;
    }

    return new Blob([buffer], { type: 'audio/wav' });
};

const writeString = (view, offset, string) => {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
};


function App() {
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [loading, setLoading] = useState(true);
    const [tasks, setTasks] = useState([]);
    const [messages, setMessages] = useState([]);
    const [inputMessage, setInputMessage] = useState('');
    const chatContainerRef = useRef(null);
    const audioContextRef = useRef(null); // Ref for AudioContext
    const audioSourceRef = useRef(null); // Ref for audio source node (used for playing audio)

    // State for manual task input
    const [manualTaskText, setManualTaskText] = useState('');
    const [manualTaskDateTime, setManualTaskDateTime] = useState('');
    const [showModal, setShowModal] = useState(false); // State for modal visibility
    const [modalMessage, setModalMessage] = useState(''); // State for modal message
    const [minDateTime, setMinDateTime] = useState(''); // State to hold the minimum allowed date-time

    const chatHistory = useRef([]);

    // Voice recording states
    const [isRecording, setIsRecording] = useState(false);
    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);

    useEffect(() => {
        const app = initializeApp(firebaseConfig);
        const firestore = getFirestore(app);
        const authInstance = getAuth(app);
        setDb(firestore);
        setAuth(authInstance);

        const unsubscribe = onAuthStateChanged(authInstance, async (user) => {
            if (user) {
                setUserId(user.uid);
            } else {
                try {
                    if (initialAuthToken) {
                        await signInWithCustomToken(authInstance, initialAuthToken);
                    } else {
                        await signInAnonymously(authInstance);
                    }
                } catch (error) {
                    console.error("Firebase authentication error:", error);
                }
            }
            setLoading(false);
        });

        // Initialize AudioContext
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();

        // Set current date and time for min attribute
        const now = new Date();
        const year = now.getFullYear();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const day = now.getDate().toString().padStart(2, '0');
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        setMinDateTime(`${year}-${month}-${day}T${hours}:${minutes}`);

        return () => {
            unsubscribe();
            if (audioContextRef.current) {
                audioContextRef.current.close();
            }
        };
    }, []);

    useEffect(() => {
        if (db && userId) {
            const tasksCollectionRef = collection(db, `artifacts/${appId}/users/${userId}/tasks`);
            // Order tasks by dateTime for consistent display and next task logic
            const q = query(tasksCollectionRef, orderBy('dateTime', 'asc'));

            const unsubscribe = onSnapshot(q, (snapshot) => {
                const fetchedTasks = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data(),
                    dateTime: doc.data().dateTime.toDate() // Convert Firestore Timestamp to Date object
                }));
                setTasks(fetchedTasks);
            }, (error) => {
                console.error("Error fetching tasks:", error);
            });

            return () => unsubscribe();
        }
    }, [db, userId]);

    // Scroll to bottom of chat
    useEffect(() => {
        if (chatContainerRef.current) {
            chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
        }
    }, [messages]);

    // Alarm and Notification Logic
    useEffect(() => {
        if (!("Notification" in window)) {
            console.warn("This browser does not support desktop notification");
            return;
        } else if (Notification.permission === "default") {
            Notification.requestPermission();
        }

        const interval = setInterval(() => {
            const now = new Date();
            tasks.forEach(task => {
                // Trigger within a 60-second window before the task time and if not completed
                if (!task.completed && task.dateTime && task.dateTime.getTime() <= now.getTime() && task.dateTime.getTime() > now.getTime() - 60 * 1000) {
                    // Play alarm sound using TTS
                    playAlarmSound(task.text);

                    // Show notification
                    new Notification("Time for your task!", {
                        body: `Your task is: ${task.text}`,
                        icon: 'https://placehold.co/128x128/0000FF/FFFFFF?text=🔔'
                    });

                    // Optionally mark as completed or provide an option to dismiss
                    // updateTask(task.id, { completed: true }); // Auto-complete for now if desired
                }
            });
        }, 10000); // Check every 10 seconds

        return () => clearInterval(interval);
    }, [tasks]);

    // Function to play alarm sound using TTS
    const playAlarmSound = async (taskText) => {
        if (!audioContextRef.current) return;

        // Stop any currently playing sound to prevent overlap
        if (audioSourceRef.current) {
            audioSourceRef.current.stop();
            audioSourceRef.current.disconnect();
            audioSourceRef.current = null;
        }

        const prompt = `Say cheerfully: It's time for your task: ${taskText}`;
        const payload = {
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: "Kore" } // Using Kore voice
                    }
                }
            },
            model: "gemini-2.5-flash-preview-tts"
        };

        const apiKey = "AIzaSyCs7X3Qn4z-z4KNz2Tzrjr8tMJpga4t5LM"; // API key will be provided by the environment
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;

        try {
            const response = await exponentialBackoff(() => fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }));
            const result = await response.json();

            // Robust error checking for TTS API response structure
            if (!result || !result.candidates || result.candidates.length === 0 ||
                !result.candidates[0].content || !result.candidates[0].content.parts ||
                result.candidates[0].content.parts.length === 0) {
                console.error("TTS API response structure is unexpected or empty for alarm:", result);
                // Fallback to a simple beep sound if TTS fails
                const audio = new Audio('data:audio/wav;base64,UklGRlIAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAZGF0YQBAAAAAAA==');
                audio.play();
                return;
            }

            const part = result.candidates[0].content.parts[0];
            const audioData = part?.inlineData?.data;
            const mimeType = part?.inlineData?.mimeType;

            if (audioData && mimeType && mimeType.startsWith("audio/L16")) {
                const sampleRateMatch = mimeType.match(/rate=(\d+)/);
                const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 16000; // Default sample rate if not found

                const pcmData = base64ToArrayBuffer(audioData);
                const pcm16 = new Int16Array(pcmData);
                const wavBlob = pcmToWav(pcm16, sampleRate);
                const audio = new Audio(URL.createObjectURL(wavBlob));
                audio.play();

                // Clean up the URL after playing
                audio.onended = () => URL.revokeObjectURL(audio.src);
            } else {
                console.error("TTS audio data not found or invalid mimeType for alarm:", result);
                // Fallback to a simple beep sound if TTS fails
                const audio = new Audio('data:audio/wav;base64,UklGRlIAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAZGF0YQBAAAAAAA==');
                audio.play();
            }
        } catch (error) {
            console.error("Error generating or playing TTS alarm:", error);
            // Fallback to a simple browser beep sound if TTS fails
            const audio = new Audio('data:audio/wav;base64,UklGRlIAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAZGF0YQBAAAAAAA==');
            audio.play();
        }
    };

    // Function to add a new task to Firestore
    const addTask = async (text, dateTime) => {
        if (!db || !userId) return;
        try {
            await addDoc(collection(db, `artifacts/${appId}/users/${userId}/tasks`), {
                text,
                dateTime,
                completed: false,
                createdAt: new Date()
            });
        } catch (error) {
            console.error("Error adding task:", error);
        }
    };

    // Function to handle manual task addition
    const handleManualAddTask = async () => {
        if (!manualTaskText.trim() || !manualTaskDateTime) {
            setModalMessage("Please enter both task description and date/time.");
            setShowModal(true);
            return;
        }
        const taskDateTime = new Date(manualTaskDateTime);
        // Additional validation to ensure the selected date/time is not in the past
        if (taskDateTime.getTime() < new Date().getTime()) {
            setModalMessage("Cannot add a task for a past date or time.");
            setShowModal(true);
            return;
        }
        if (isNaN(taskDateTime.getTime())) {
            setModalMessage("Invalid date or time format.");
            setShowModal(true);
            return;
        }
        await addTask(manualTaskText, taskDateTime);
        setManualTaskText('');
        setManualTaskDateTime('');
    };

    // Function to update an existing task in Firestore
    const updateTask = async (id, updates) => {
        if (!db || !userId) return;
        try {
            await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/tasks`, id), updates);
        } catch (error) {
            console.error("Error updating task:", error);
        }
    };

    // Function to delete a task from Firestore
    const deleteTask = async (id) => {
        if (!db || !userId) return;
        try {
            await deleteDoc(doc(db, `artifacts/${appId}/users/${userId}/tasks`, id));
        } catch (error) {
            console.error("Error deleting task:", error);
        }
    };

    // Function to send message to AI assistant (unified for text and voice)
    const sendMessageToAI = async (messageText) => {
        if (!messageText.trim()) return;

        const userMessage = { role: "user", text: messageText };
        setMessages(prev => [...prev, userMessage]);
        chatHistory.current.push({ role: "user", parts: [{ text: messageText }] }); // Maintain chat history for AI context

        // Prepare current tasks information for AI context
        const currentTaskInfo = tasks.length > 0
            ? tasks.map(t => `- ID: ${t.id}, Task: ${t.text} (Time: ${t.dateTime.toLocaleString()}${t.completed ? ', Completed' : ''})`).join('\n')
            : 'No tasks available.';

        // LLM Prompt for AI
        const llmPrompt = `You are an AI assistant that helps the user manage their tasks.
        You can perform the following actions:
        1.  Add a new task: If the user requests to add a new task, extract the task description, date, and time. Ensure the date and time are in the future.
        2.  Tell the next task: If the user asks about their next task, identify the earliest uncompleted task from the list.
        3.  Mark a task as complete: If the user asks to complete a task, use its ID to mark it as complete.
        4.  Delete a task: If the user asks to delete a task, use its ID to delete it.
        5.  General response: For any other conversation, provide a general text response.

        Here is the current list of tasks (for context):
        ${currentTaskInfo}

        User's message: ${messageText}

        Please respond in English. Return your response in JSON format with an 'action' field and relevant data:

        - To add a task:
          { "action": "add_task", "text": "Task description", "date": "YYYY-MM-DD", "time": "HH:MM" }
        - To ask about the next task (just send the action, client-side will determine):
          { "action": "next_task" }
        - To mark a task as complete:
          { "action": "complete_task", "id": "Firestore ID of the task" }
        - To delete a task:
          { "action": "delete_task", "id": "Firestore ID of the task" }
        - For general conversation:
          { "action": "general_response", "text": "Your response in English" }
        `;

        const payload = {
            contents: [{ role: "user", parts: [{ text: llmPrompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        "action": { "type": "STRING", "enum": ["add_task", "next_task", "complete_task", "delete_task", "general_response"] },
                        "text": { "type": "STRING" }, // For add_task or general_response
                        "date": { "type": "STRING" }, // For add_task
                        "time": { "type": "STRING" }, // For add_task
                        "id": { "type": "STRING" }  // For complete_task, delete_task
                    },
                    "required": ["action"]
                }
            }
        };

        const apiKey = "AIzaSyCs7X3Qn4z-z4KNz2Tzrjr8tMJpga4t5LM"; // API key will be provided by the environment
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

        try {
            const response = await exponentialBackoff(() => fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }));
            const result = await response.json();

            const aiResponseText = result.candidates?.[0]?.content?.parts?.[0]?.text;

            if (aiResponseText) {
                let aiResponse;
                try {
                    aiResponse = JSON.parse(aiResponseText);
                } catch (e) {
                    // Fallback if AI doesn't return valid JSON, assume it's a general text response
                    aiResponse = { action: "general_response", text: aiResponseText };
                }

                switch (aiResponse.action) {
                    case "add_task":
                        if (aiResponse.text && aiResponse.date && aiResponse.time) {
                            const dateTimeString = `${aiResponse.date}T${aiResponse.time}`;
                            const taskDateTime = new Date(dateTimeString);
                            // Validate if the AI-provided date/time is in the future
                            if (taskDateTime.getTime() < new Date().getTime()) {
                                const botMessage = { role: "bot", text: "I cannot add a task for a past date or time. Please provide a future date and time." };
                                setMessages(prev => [...prev, botMessage]);
                                chatHistory.current.push({ role: "model", parts: [{ text: botMessage.text }] });
                                playTTSResponse(botMessage.text); // Play AI response via TTS
                                break; // Exit case
                            }

                            if (!isNaN(taskDateTime.getTime())) {
                                await addTask(aiResponse.text, taskDateTime);
                                const botMessage = { role: "bot", text: `I've added your task "${aiResponse.text}" for ${taskDateTime.toLocaleString()}.` };
                                setMessages(prev => [...prev, botMessage]);
                                chatHistory.current.push({ role: "model", parts: [{ text: botMessage.text }] });
                                playTTSResponse(botMessage.text); // Play AI response via TTS
                            } else {
                                const botMessage = { role: "bot", text: "Sorry, I couldn't understand the date and time you provided. Please specify clearly." };
                                setMessages(prev => [...prev, botMessage]);
                                chatHistory.current.push({ role: "model", parts: [{ text: botMessage.text }] });
                                playTTSResponse(botMessage.text); // Play AI response via TTS
                            }
                        } else {
                            const botMessage = { role: "bot", text: "To add a task, I need both a description, date, and time." };
                            setMessages(prev => [...prev, botMessage]);
                            chatHistory.current.push({ role: "model", parts: [{ text: botMessage.text }] });
                            playTTSResponse(botMessage.text); // Play AI response via TTS
                        }
                        break;
                    case "next_task":
                        const now = new Date();
                        const nextTask = tasks.find(task => !task.completed && task.dateTime > now);
                        if (nextTask) {
                            const botMessage = { role: "bot", text: `Your next task is: "${nextTask.text}", which is at ${nextTask.dateTime.toLocaleString()}.` };
                            setMessages(prev => [...prev, botMessage]);
                            chatHistory.current.push({ role: "model", parts: [{ text: botMessage.text }] });
                            playTTSResponse(botMessage.text); // Play AI response via TTS
                        } else {
                            const botMessage = { role: "bot", text: "You don't have any upcoming tasks." };
                            setMessages(prev => [...prev, botMessage]);
                            chatHistory.current.push({ role: "model", parts: [{ text: botMessage.text }] });
                            playTTSResponse(botMessage.text); // Play AI response via TTS
                        }
                        break;
                    case "complete_task":
                        if (aiResponse.id) {
                            const taskToUpdate = tasks.find(t => t.id === aiResponse.id);
                            if (taskToUpdate) {
                                await updateTask(aiResponse.id, { completed: true });
                                const botMessage = { role: "bot", text: `I've marked the task "${taskToUpdate.text}" as complete.` };
                                setMessages(prev => [...prev, botMessage]);
                                chatHistory.current.push({ role: "model", parts: [{ text: botMessage.text }] });
                                playTTSResponse(botMessage.text); // Play AI response via TTS
                            } else {
                                const botMessage = { role: "bot", text: "That task was not found. Please provide the correct ID." };
                                setMessages(prev => [...prev, botMessage]);
                                chatHistory.current.push({ role: "model", parts: [{ text: botMessage.text }] });
                                playTTSResponse(botMessage.text); // Play AI response via TTS
                            }
                        } else {
                            const botMessage = { role: "bot", text: "To complete a task, I need the task ID." };
                            setMessages(prev => [...prev, botMessage]);
                            chatHistory.current.push({ role: "model", parts: [{ text: botMessage.text }] });
                            playTTSResponse(botMessage.text); // Play AI response via TTS
                        }
                        break;
                    case "delete_task":
                        if (aiResponse.id) {
                            const taskToDelete = tasks.find(t => t.id === aiResponse.id);
                            if (taskToDelete) {
                                await deleteTask(aiResponse.id);
                                const botMessage = { role: "bot", text: `I've deleted the task "${taskToDelete.text}".` };
                                setMessages(prev => [...prev, botMessage]);
                                chatHistory.current.push({ role: "model", parts: [{ text: botMessage.text }] });
                                playTTSResponse(botMessage.text); // Play AI response via TTS
                            } else {
                                const botMessage = { role: "bot", text: "That task was not found. Please provide the correct ID." };
                                setMessages(prev => [...prev, botMessage]);
                                chatHistory.current.push({ role: "model", parts: [{ text: botMessage.text }] });
                                playTTSResponse(botMessage.text); // Play AI response via TTS
                            }
                        } else {
                            const botMessage = { role: "bot", text: "To delete a task, I need the task ID." };
                            setMessages(prev => [...prev, botMessage]);
                            chatHistory.current.push({ role: "model", parts: [{ text: botMessage.text }] });
                            playTTSResponse(botMessage.text); // Play AI response via TTS
                        }
                        break;
                    case "general_response":
                    default:
                        const botMessage = { role: "bot", text: aiResponse.text || "Sorry, I didn't understand your request. Could you please clarify?" };
                        setMessages(prev => [...prev, botMessage]);
                        chatHistory.current.push({ role: "model", parts: [{ text: botMessage.text }] });
                        playTTSResponse(botMessage.text); // Play AI response via TTS
                        break;
                }
            } else {
                const botMessage = { role: "bot", text: "Sorry, there was a problem getting a response from the AI." };
                setMessages(prev => [...prev, botMessage]);
                chatHistory.current.push({ role: "model", parts: [{ text: botMessage.text }] });
                playTTSResponse(botMessage.text); // Play AI response via TTS
            }
        } catch (error) {
            console.error("Error communicating with AI:", error);
            const botMessage = { role: "bot", text: "There was an issue communicating with the AI. Please try again." };
            setMessages(prev => [...prev, botMessage]);
            chatHistory.current.push({ role: "model", parts: [{ text: botMessage.text }] });
            playTTSResponse(botMessage.text); // Play AI response via TTS
        }
    };

    // Function to play AI's text response via TTS
    const playTTSResponse = async (text) => {
        if (!audioContextRef.current) return;

        // Stop any currently playing sound
        if (audioSourceRef.current) {
            audioSourceRef.current.stop();
            audioSourceRef.current.disconnect();
            audioSourceRef.current = null;
        }

        const payload = {
            contents: [{
                parts: [{ text: text }]
            }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: "Puck" } // Using a different voice for general AI response
                    }
                }
            },
            model: "gemini-2.5-flash-preview-tts"
        };

        const apiKey = "AIzaSyCs7X3Qn4z-z4KNz2Tzrjr8tMJpga4t5LM";
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;

        try {
            const response = await exponentialBackoff(() => fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }));
            const result = await response.json();

            // Robust error checking for TTS API response structure
            if (!result || !result.candidates || result.candidates.length === 0 ||
                !result.candidates[0].content || !result.candidates[0].content.parts ||
                result.candidates[0].content.parts.length === 0) {
                console.error("TTS API response structure is unexpected or empty for AI response:", result);
                return; // Do not attempt to play malformed audio
            }

            const part = result.candidates[0].content.parts[0];
            const audioData = part?.inlineData?.data;
            const mimeType = part?.inlineData?.mimeType;

            if (audioData && mimeType && mimeType.startsWith("audio/L16")) {
                const sampleRateMatch = mimeType.match(/rate=(\d+)/);
                const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 16000;

                const pcmData = base64ToArrayBuffer(audioData);
                const pcm16 = new Int16Array(pcmData);
                const wavBlob = pcmToWav(pcm16, sampleRate);
                const audio = new Audio(URL.createObjectURL(wavBlob));
                audio.play();
                audio.onended = () => URL.revokeObjectURL(audio.src);
            } else {
                console.error("TTS audio data for AI response not found or invalid mimeType:", result);
            }
        } catch (error) {
            console.error("Error generating or playing AI TTS response:", error);
        }
    };


    const handleTextSendMessage = () => {
        sendMessageToAI(inputMessage);
        setInputMessage('');
    };

    const startRecording = async () => {
        // Stop any active AI speech before starting user recording
        if (audioSourceRef.current) {
            audioSourceRef.current.stop();
            audioSourceRef.current.disconnect();
            audioSourceRef.current = null;
        }

        try {
            // Request microphone permission here, directly before starting MediaRecorder
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorderRef.current = new MediaRecorder(stream);
            audioChunksRef.current = [];
            
            mediaRecorderRef.current.ondataavailable = (event) => {
                audioChunksRef.current.push(event.data);
            };

            mediaRecorderRef.current.onstop = async () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.readAsDataURL(audioBlob);
                reader.onloadend = () => {
                    const base64data = reader.result.split(',')[1];
                    sendAudioToSTT(base64data);
                };
            };

            mediaRecorderRef.current.start();
            setIsRecording(true);
            setModalMessage("Recording started... Click mic again to stop.");
            setShowModal(true);
        } catch (error) {
            console.error("Error accessing microphone:", error);
            // Show a more specific message if permission is denied
            if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
                setModalMessage("Microphone access denied. Please allow microphone usage in your browser settings to use voice features.");
            } else {
                setModalMessage("Error accessing microphone. Please ensure permissions are granted.");
            }
            setShowModal(true);
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
            mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop()); // Stop microphone track
            setIsRecording(false);
            setModalMessage("Recording stopped. Processing audio...");
            setShowModal(true);
        }
    };

    const sendAudioToSTT = async (audioBase64) => {
        const payload = {
            contents: [
                {
                    role: "user",
                    parts: [
                        { inlineData: { mimeType: "audio/webm", data: audioBase64 } },
                        { text: "Transcribe this audio in English." } // Explicitly request English transcription
                    ]
                }
            ],
        };

        const apiKey = "AIzaSyCs7X3Qn4z-z4KNz2Tzrjr8tMJpga4t5LM"; // API key will be provided by the environment
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

        try {
            const response = await exponentialBackoff(() => fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }));
            const result = await response.json();
            const transcribedText = result.candidates?.[0]?.content?.parts?.[0]?.text;

            if (transcribedText) {
                setModalMessage("Audio transcribed successfully!");
                setShowModal(false); // Hide modal after transcription
                sendMessageToAI(transcribedText); // Send transcribed text to the main AI logic
            } else {
                setModalMessage("Could not transcribe audio. Please try again.");
                setShowModal(true);
                console.error("STT failed: No transcribed text found.", result);
            }
        } catch (error) {
            setModalMessage("Error during speech-to-text. Please try again.");
            setShowModal(true);
            console.error("Error sending audio to STT:", error);
        }
    };


    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-gray-100 dark:bg-gray-900 text-gray-800 dark:text-gray-200">
                <div className="text-xl font-semibold">Loading...</div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-100 dark:bg-gray-900 flex flex-col items-center justify-center p-4 font-inter text-gray-900 dark:text-gray-100">
            {/* Custom Scrollbar Styles */}
            <style>{`
                .custom-scrollbar::-webkit-scrollbar {
                    width: 8px;
                    height: 8px;
                }
                .custom-scrollbar::-webkit-scrollbar-track {
                    background: #f1f1f1;
                    border-radius: 10px;
                }
                .dark .custom-scrollbar::-webkit-scrollbar-track {
                    background: #333;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb {
                    background: #888;
                    border-radius: 10px;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                    background: #555;
                }
                .dark .custom-scrollbar::-webkit-scrollbar-thumb {
                    background: #555;
                }
                .dark .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                    background: #777;
                }
            `}</style>
            
            <div className="w-full max-w-5xl bg-white dark:bg-gray-800 rounded-2xl shadow-xl flex flex-col md:flex-row overflow-hidden">
                {/* Task List Section */}
                {/* On small screens, this section takes full width and then wraps to next line */}
                <div className="flex-1 p-6 md:p-8 bg-white dark:bg-gray-700 max-h-[calc(100vh-120px)] md:max-h-[85vh] overflow-y-auto custom-scrollbar md:border-r border-gray-200 dark:border-gray-600">
                    <h2 className="text-3xl font-bold mb-6 text-gray-800 dark:text-gray-100 flex items-center">
                        <Bell className="mr-3 text-blue-500" size={32} />
                        Your Tasks
                    </h2>

                    {/* Manual Task Input Section */}
                    <div className="mb-8 p-5 bg-blue-50 dark:bg-blue-900/20 rounded-xl shadow-inner border border-blue-100 dark:border-blue-800">
                        <h3 className="text-xl font-semibold mb-4 text-gray-800 dark:text-gray-100 flex items-center">
                            <Plus className="mr-2 text-green-500" size={24} />
                            Add New Task Manually
                        </h3>
                        {/* Grid layout for inputs, responsive stacking on small screens */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <input
                                type="text"
                                placeholder="Task description"
                                value={manualTaskText}
                                onChange={(e) => setManualTaskText(e.target.value)}
                                className="p-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-400 transition-all duration-200"
                            />
                            <input
                                type="datetime-local"
                                value={manualTaskDateTime}
                                onChange={(e) => setManualTaskDateTime(e.target.value)}
                                min={minDateTime} // Set the minimum allowed date-time
                                className="p-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-400 transition-all duration-200"
                            />
                            <button
                                onClick={handleManualAddTask}
                                className="p-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg shadow-md transition-all duration-200 flex items-center justify-center transform hover:scale-105"
                                aria-label="Add task"
                            >
                                <Plus size={20} className="mr-2" />
                                Add Task
                            </button>
                        </div>
                    </div>

                    {/* Task List Display */}
                    {tasks.length === 0 ? (
                        <p className="text-gray-600 dark:text-gray-300 text-lg text-center py-4">No tasks found. Talk to your AI assistant or add one manually!</p>
                    ) : (
                        <ul className="space-y-4">
                            {tasks.map(task => (
                                <li key={task.id} className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-4 bg-gray-50 dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-600 hover:shadow-md transition-all duration-200">
                                    <div className="flex-1 mb-2 sm:mb-0">
                                        <p className={`text-lg font-medium ${task.completed ? 'line-through text-gray-400 dark:text-gray-500' : 'text-gray-900 dark:text-gray-100'}`}>
                                            {task.text}
                                        </p>
                                        <p className={`text-sm text-gray-500 dark:text-gray-400 mt-1 flex items-center ${task.completed ? 'line-through' : ''}`}>
                                            <Clock size={16} className="mr-1" />
                                            {task.dateTime.toLocaleString()}
                                        </p>
                                        <p className="text-xs text-gray-400 dark:text-gray-600 mt-1">ID: {task.id}</p>
                                    </div>
                                    <div className="flex items-center space-x-2 ml-0 sm:ml-4">
                                        {!task.completed && (
                                            <button
                                                onClick={() => updateTask(task.id, { completed: true })}
                                                className="p-2 rounded-full bg-green-100 hover:bg-green-200 text-green-700 dark:bg-green-700 dark:hover:bg-green-600 dark:text-green-200 transition-colors transform hover:scale-110"
                                                aria-label="Mark as complete"
                                                title="Mark as complete"
                                            >
                                                <CheckCircle size={20} />
                                            </button>
                                        )}
                                        {task.completed && (
                                            <span className="p-2 text-green-500 dark:text-green-400" title="Completed">
                                                <CircleDot size={20} />
                                            </span>
                                        )}
                                        <button
                                            onClick={() => deleteTask(task.id)}
                                            className="p-2 rounded-full bg-red-100 hover:bg-red-200 text-red-700 dark:bg-red-700 dark:hover:bg-red-600 dark:text-red-200 transition-colors transform hover:scale-110"
                                            aria-label="Delete task"
                                            title="Delete task"
                                        >
                                            <Trash2 size={20} />
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                {/* AI Assistant Section */}
                {/* On small screens, this section takes full width and then wraps to next line */}
                <div className="flex-1 p-6 md:p-8 bg-gray-50 dark:bg-gray-800 flex flex-col max-h-[calc(100vh-120px)] md:max-h-[85vh]">
                    <h2 className="text-3xl font-bold mb-6 text-gray-800 dark:text-gray-100 flex items-center">
                        <MessageSquare className="mr-3 text-purple-500" size={32} />
                        AI Assistant
                    </h2>
                    <div ref={chatContainerRef} className="flex-1 overflow-y-auto space-y-4 mb-6 pr-2 custom-scrollbar">
                        {messages.length === 0 && (
                            <div className="text-center text-gray-500 dark:text-gray-400 italic py-4">
                                Hi there! How can I help you today?
                            </div>
                        )}
                        {messages.map((msg, index) => (
                            <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[75%] p-4 rounded-2xl ${
                                    msg.role === 'user'
                                        ? 'bg-blue-500 text-white rounded-br-none'
                                        : 'bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-100 rounded-bl-none'
                                } shadow-md`}>
                                    {msg.text}
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className="flex items-center border-t border-gray-200 dark:border-gray-700 pt-4">
                        <input
                            type="text"
                            value={inputMessage}
                            onChange={(e) => setInputMessage(e.target.value)}
                            onKeyPress={(e) => e.key === 'Enter' && handleTextSendMessage()} // Use handleTextSendMessage for text input
                            placeholder="Chat with your AI assistant..."
                            className="flex-1 p-3 rounded-l-full border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-400 transition-all duration-200"
                        />
                        <button
                            onClick={handleTextSendMessage} // Send text message
                            className="p-3 bg-purple-600 hover:bg-purple-700 text-white rounded-r-none shadow-lg transition-colors duration-200 flex items-center justify-center transform hover:scale-105"
                            aria-label="Send message"
                            title="Send text message"
                        >
                            <Send size={24} />
                        </button>
                        <button
                            onClick={isRecording ? stopRecording : startRecording} // Toggle record/stop
                            className={`p-3 ml-1 ${isRecording ? 'bg-red-500 hover:bg-red-600' : 'bg-green-500 hover:bg-green-600'} text-white rounded-r-full shadow-lg transition-colors duration-200 flex items-center justify-center transform hover:scale-105`}
                            aria-label={isRecording ? "Stop recording" : "Start recording"}
                            title={isRecording ? "Stop recording" : "Start recording"}
                        >
                            {isRecording ? <StopCircle size={24} /> : <Mic size={24} />}
                        </button>
                    </div>
                    {userId && (
                        <div className="text-xs text-gray-500 dark:text-gray-600 mt-2 text-center">
                            User ID: {userId}
                        </div>
                    )}
                </div>
            </div>

            {/* Modal for Alerts */}
            {showModal && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                    <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl max-w-sm w-full text-center relative">
                        <button
                            onClick={() => setShowModal(false)}
                            className="absolute top-3 right-3 p-1 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                            aria-label="Close"
                        >
                            <X size={20} />
                        </button>
                        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{modalMessage}</p>
                        <button
                            onClick={() => setShowModal(false)}
                            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md shadow transition-colors"
                        >
                            OK
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

export default App;
