const net = require('net');
const multiparty = require('multiparty');
const logger = require('./logger');

class TCPServer {
    constructor(io, port = 9001) {
        this.io = io;
        this.port = port;
        this.server = null;
        this.isOnline = false;
        this.isProcessing = false;
    }

    emitStatus() {
        this.io.emit('tcp-server-status', {
            isOnline: this.isOnline,
            isProcessing: this.isProcessing
        });
    }

    start() {
        logger.info('Starting TCP Server...');
        this.server = net.createServer((socket) => {
            const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
            logger.info(`New TCP connection from ${clientAddress}`);
            let data = Buffer.from([]);

            let dataTimeout;
            const TIMEOUT_MS = 5000; // 5 seconds timeout for data reception
            const resetTimeout = () => {
                if (dataTimeout) clearTimeout(dataTimeout);
                dataTimeout = setTimeout(() => {
                    logger.warn(`Data reception timeout for ${clientAddress}`);
                    socket.end();
                }, TIMEOUT_MS);
            };

            socket.on('data', (chunk) => {
                this.isProcessing = true;
                this.emitStatus();
                resetTimeout();
                logger.debug(`Receiving data from ${clientAddress}, chunk size: ${chunk.length} bytes`);
                data = Buffer.concat([data, chunk]);
            });

            socket.on('end', () => {
                if (dataTimeout) clearTimeout(dataTimeout);
                logger.info(`Connection ended from ${clientAddress}`);
                
                if (data.length < 100) { // Minimum data size threshold
                    logger.warn(`Received data too small (${data.length} bytes) from ${clientAddress}`);
                    this.isProcessing = false;
                    this.emitStatus();
                    return;
                }
                
                this.handleRequest(data).finally(() => {
                    this.isProcessing = false;
                    this.emitStatus();
                });
            });

            socket.on('error', (error) => {
                logger.error(`TCP Socket error from ${clientAddress}:`, error);
                this.isProcessing = false;
                this.emitStatus();
            });
        });

        this.server.listen(this.port, () => {
            this.isOnline = true;
            this.emitStatus();
            logger.info(`TCP Server listening on port ${this.port}`);
        });

        this.server.on('error', (error) => {
            this.isOnline = false;
            this.emitStatus();
            logger.error('TCP Server error:', error);
        });

        this.server.on('close', () => {
            this.isOnline = false;
            this.emitStatus();
            logger.info('TCP Server closed');
        });
    }

    async handleRequest(data) {
        try {
            logger.debug(`Processing TCP request, data size: ${data.length} bytes`);
            
            if (data.length === 0) {
                throw new Error('Empty request data received');
            }

            const { Readable } = require('stream');
            const { EventEmitter } = require('events');
            
            class RequestLike extends EventEmitter {
                constructor(data) {
                    super();
                    const boundary = 'boundary' + Date.now();
                    this.headers = {
                        'content-type': `multipart/form-data; boundary=${boundary}`,
                        'content-length': data.length
                    };
                    this.data = data;
                }

                pipe(destination) {
                    const readable = Readable.from(this.data);
                    readable.on('end', () => {
                        this.emit('end');
                    });
                    readable.pipe(destination);
                    return destination;
                }
            }
            
            const req = new RequestLike(data);
            const form = new multiparty.Form();
            
            const parseForm = new Promise((resolve, reject) => {
                form.on('error', (error) => {
                    reject(error);
                });

                form.parse(req, (error, fields, files) => {
                    if (error) {
                        logger.error('Form parsing error:', error);
                        reject(error);
                        return;
                    }
                    logger.debug('Form parsed successfully');
                    resolve({ fields, files });
                });
            });

            const { fields, files } = await parseForm;

            const anprData = {
                timestamp: new Date().toISOString(),
                plateNumber: fields.plateNumber?.[0] || 'Unknown',
                confidence: fields.confidence?.[0] || '0',
                cameraId: fields.cameraId?.[0],
                location: fields.location?.[0],
                images: []
            };

            logger.debug('ANPR data extracted:', anprData);

            if (files.images) {
                logger.debug(`Processing ${Math.min(files.images.length, 3)} images`);
                for (let i = 0; i < Math.min(files.images.length, 3); i++) {
                    const image = files.images[i];
                    anprData.images.push({
                        path: image.path,
                        size: image.size,
                        type: image.headers['content-type']
                    });
                }
            }

            this.io.emit('anpr-detection', anprData);
            logger.info('ANPR detection processed successfully:', anprData);

        } catch (error) {
            logger.error('Error processing TCP ANPR data:', error);
            throw error;
        }
    }

    stop() {
        if (this.server) {
            logger.info('Stopping TCP Server...');
            this.server.close(() => {
                this.isOnline = false;
                this.emitStatus();
                logger.info('TCP Server stopped');
            });
        }
    }
}

module.exports = TCPServer;