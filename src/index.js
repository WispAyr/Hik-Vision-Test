require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const logger = require('./logger');
const fetch = require('node-fetch');
const xml2js = require('xml2js');
const TCPServer = require('./tcpServer');
let DigestFetch;
(async () => {
    DigestFetch = (await import('digest-fetch')).default;
})();

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Serve static files from public directory
app.use(express.static('public'));

// Store active camera connections
const activeConnections = new Map();

// WebSocket connection handling
io.on('connection', async (socket) => {
    logger.info('Client connected');

    socket.on('connect-camera', async ({ camera, index }) => {
        const cameraKey = `${camera.ip}:${camera.port}`;
        try {
            // Check if camera is already connected
            if (activeConnections.has(cameraKey)) {
                logger.error(`Connection attempt failed for camera ${camera.name}: Already connected`);
                socket.emit('camera-error', { index, error: 'Camera is already connected' });
                return;
            }
            
            logger.info(`Attempting to connect to camera ${camera.name} at ${camera.ip}:${camera.port}`);            
            logger.debug('Initiating authentication process', {
                camera: {
                    name: camera.name,
                    ip: camera.ip,
                    port: camera.port
                }
            });
            socket.emit('camera-connecting', { index });

            logger.debug('Creating Hikvision camera instance', {
                host: camera.ip,
                port: camera.port || 80,
                username: camera.username
            });

            // Create Hikvision camera connection with retry mechanism
            const client = new DigestFetch(camera.username, camera.password, {
                timeout: 10000, // 10 second timeout for requests
                retries: 3,    // Retry failed requests up to 3 times
                retryDelay: 2000, // Wait 2 seconds between retries
                retryOn: [408, 500, 502, 503, 504] // Retry on specific HTTP status codes
            });
            const baseUrl = `http://${camera.ip}:${camera.port}`;
            
            logger.debug('Testing connection by fetching device info');
            // Test connection by fetching device info with error handling
            try {
                const response = await client.fetch(`${baseUrl}/ISAPI/System/deviceInfo`, {
                    signal: AbortSignal.timeout(15000) // Additional timeout safety
                });
                logger.debug('Device info response status:', { status: response.status, statusText: response.statusText });
                if (!response.ok) {
                    throw new Error(`Failed to connect to camera: ${response.statusText}`);
                }
                
                // Parse device info response to verify camera compatibility
                const deviceInfo = await response.text();
                if (!deviceInfo.includes('Hikvision')) {
                    throw new Error('Invalid camera response - not a Hikvision device');
                }
            } catch (error) {
                logger.error(`Failed to verify camera ${camera.name}:`, error);
                if (error.name === 'AbortError' || error.code === 'ETIMEDOUT') {
                    throw new Error(`Connection timed out. Please check if the camera is reachable at ${camera.ip}:${camera.port}`);
                }
                throw new Error(`Camera verification failed: ${error.message}`);
            }
            
            logger.debug('Establishing ANPR event stream connection');
            // Create event stream for ANPR with timeout and error handling
            let eventStream;
            try {
                eventStream = await client.fetch(`${baseUrl}/ISAPI/Event/notification/alertStream`);
                logger.debug('Event stream response status:', { status: eventStream.status, statusText: eventStream.statusText });
                if (!eventStream.ok) {
                    throw new Error('Failed to establish event stream');
                }
            } catch (error) {
                logger.error(`Failed to establish event stream for camera ${camera.name}:`, error);
                throw new Error(`Event stream connection failed: ${error.message}`);
            }
            
            const reader = eventStream.body.getReader();
            const parser = new xml2js.Parser();
            
            // Create enhanced camera object with better state management
            const hikCamera = {
                isConnected: true,
                lastKeepAlive: Date.now(),
                reconnectAttempts: 0,
                disconnect: () => {
                    hikCamera.isConnected = false;
                    reader.cancel();
                    logger.info(`Camera ${camera.name} disconnected`);
                },
                getSystemInfo: async () => {
                    const response = await client.fetch(`${baseUrl}/ISAPI/System/status`);
                    if (!response.ok) {
                        throw new Error('Failed to get system status');
                    }
                    return response.text();
                },
                on: (event, callback) => {
                    if (event === 'close') {
                        logger.info(`Camera ${camera.name} connection closed`);
                    }
                    if (event === 'error') {
                        logger.error(`Camera ${camera.name} encountered an error`);
                    }
                }
            };
            
            logger.info(`Event stream established successfully for camera ${camera.name}`);
            // Start reading the event stream
            const readStream = async () => {
                try {
                    while (hikCamera.isConnected) {
                        const {value, done} = await reader.read();
                        if (done) break;
                        
                        const text = new TextDecoder().decode(value);
                        if (text.includes('licensePlate')) {
                            parser.parseString(text, (err, result) => {
                                if (err) {
                                    logger.error('Error parsing ANPR event:', err);
                                    return;
                                }
                                
                                if (result && result.EventNotificationAlert) {
                                    const event = {
                                        licensePlate: result.EventNotificationAlert.ANPR?.[0]?.licensePlate?.[0] || 'Unknown',
                                        eventTime: result.EventNotificationAlert.dateTime?.[0] || new Date().toISOString(),
                                        confidence: result.EventNotificationAlert.ANPR?.[0]?.confidence?.[0] || '0',
                                        snapPicUrl: result.EventNotificationAlert.ANPR?.[0]?.snapPicUrl?.[0] || '',
                                        laneNo: result.EventNotificationAlert.ANPR?.[0]?.laneNo?.[0] || 'Unknown'
                                    };
                                    io.emit('anpr-detection', event);
                                }
                            });
                        }
                    }
                } catch (error) {
                    logger.error('Error reading event stream:', error);
                    socket.emit('camera-error', { index, error: error.message });
                    cleanupConnection(cameraKey);
                }
            };
            
            readStream();

            // Store the connection with additional metadata
            const connection = {
                hikCamera,
                camera,
                index,
                lastKeepAlive: Date.now(),
                reconnectAttempts: 0
            };
            activeConnections.set(cameraKey, connection);

            // Implement keep-alive mechanism
            const keepAliveInterval = setInterval(async () => {
                try {
                    if (hikCamera.isConnected) {
                        await hikCamera.getSystemInfo();
                        connection.lastKeepAlive = Date.now();
                        connection.reconnectAttempts = 0;
                    }
                } catch (error) {
                    logger.warn(`Keep-alive failed for camera ${camera.name}:`, error);
                    if (++connection.reconnectAttempts > 3) {
                        logger.error(`Too many keep-alive failures for camera ${camera.name}, disconnecting`);
                        clearInterval(keepAliveInterval);
                        cleanupConnection(cameraKey);
                        socket.emit('camera-error', { index, error: 'Connection lost' });
                    }
                }
            }, 30000);

            // Handle ANPR events with the Ultimate package
            hikCamera.on('anpr', (event) => {
                try {
                    const anprInfo = {
                        timestamp: new Date().toISOString(),
                        plateNumber: event.licensePlate || 'Unknown',
                        captureTime: event.eventTime || '',
                        confidence: event.confidence || '0',
                        imageUrl: event.snapPicUrl || `/capture/${Date.now()}.jpg`,
                        lane: event.laneNo || 'Unknown'
                    };
                    io.emit('anpr-detection', anprInfo);
                } catch (error) {
                    logger.error(`Error processing ANPR event from camera ${camera.name}:`, error);
                }
            });

            // Handle connection events
            hikCamera.connect().then(() => {
                logger.info(`Successfully connected to camera: ${camera.name} at ${camera.ip}:${camera.port}`);
                socket.emit('camera-connected', { index });
                
                // Start ANPR event subscription
                logger.debug(`Starting ANPR stream for camera: ${camera.name}`);
                return hikCamera.startANPRStream();
            }).catch((error) => {
                const errorDetails = {
                    camera: {
                        name: camera.name,
                        ip: camera.ip,
                        port: camera.port
                    },
                    error: {
                        message: error.message,
                        code: error.code,
                        type: error.constructor.name
                    }
                };
                logger.error(`Error connecting to camera ${camera.name}`, errorDetails);
                socket.emit('camera-error', { index, error: error.message });
                cleanupConnection(cameraKey);
            });

            hikCamera.on('close', () => {
                logger.info(`Connection closed for camera: ${camera.name}`);
                socket.emit('camera-disconnected', { index });
                cleanupConnection(cameraKey);
            });

            hikCamera.on('error', (error) => {
                const errorContext = {
                    camera: {
                        name: camera.name,
                        ip: camera.ip,
                        port: camera.port,
                        connectionStatus: hikCamera.isConnected ? 'connected' : 'disconnected'
                    },
                    error: error instanceof Error ? error : new Error(error)
                };
                logger.error(`Camera error for ${camera.name}`, errorContext);
                socket.emit('camera-error', { index, error: error.message });
                cleanupConnection(cameraKey);
            });

            // Start the connection with timeout
            const connectionTimeout = setTimeout(() => {
                if (!hikCamera.isConnected) {
                    logger.error(`Connection timeout for camera ${camera.name}`);
                    socket.emit('camera-error', { index, error: 'Connection timeout' });
                    cleanupConnection(cameraKey);
                }
            }, 10000); // 10 second timeout

            await hikCamera.connect();
            clearTimeout(connectionTimeout);

        } catch (error) {
            logger.error(`Error connecting to camera ${camera.name}:`, error);
            socket.emit('camera-error', { index, error: error.message });
            cleanupConnection(cameraKey);
        }
    });

    socket.on('disconnect-camera', ({ camera, index }) => {
        const cameraKey = `${camera.ip}:${camera.port}`;
        logger.info(`Disconnecting from camera: ${camera.name}`);
        cleanupConnection(cameraKey);
        socket.emit('camera-disconnected', { index });
    });

    function cleanupConnection(key) {
        const connection = activeConnections.get(key);
        if (connection) {
            if (connection.hikCamera) {
                connection.hikCamera.disconnect();
            }
            activeConnections.delete(key);
        }
    }

    socket.on('disconnect', () => {
        logger.info('Client disconnected');
        // Cleanup all connections associated with this socket
        for (const [key, connection] of activeConnections.entries()) {
            cleanupConnection(key);
        }
    });
});

// Parse command line arguments
const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const PORT = portIndex !== -1 ? parseInt(args[portIndex + 1]) : (process.env.PORT || 3000);
const HOST = process.env.HOST || 'localhost';

// Shutdown endpoint
app.post('/shutdown', async (req, res) => {
    logger.info('Shutdown request received');
    
    // Disconnect all active cameras
    for (const [key, connection] of activeConnections.entries()) {
        logger.info(`Disconnecting camera: ${connection.camera.name}`);
        cleanupConnection(key);
    }

    // Close all socket connections
    io.close();
    
    // Send response before shutting down
    res.status(200).send('Server shutting down');
    
    // Give some time for the response to be sent and connections to be closed
    setTimeout(() => {
        logger.info('Shutting down server');
        server.close(() => {
            logger.info('Server shutdown complete');
            process.exit(0);
        });
    }, 1000);
});

// Start the server
server.listen(PORT, HOST, () => {
    logger.info(`Server running at http://${HOST}:${PORT}`);
    logger.debug('Debug logging enabled');
    
    // Initialize and start TCP server
    const tcpServer = new TCPServer(io);
    tcpServer.start();
    
    logger.debug('Application initialized successfully');
});