const fs = require('fs');
const path = require('path');

class Logger {
    constructor() {
        this.logDir = path.join(__dirname, '../logs');
        this.logFile = path.join(this.logDir, 'app.log');
        
        // Create logs directory if it doesn't exist
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    formatMessage(level, message, data = null) {
        const timestamp = new Date().toISOString();
        let dataStr = '';
        
        if (data) {
            if (data instanceof Error) {
                dataStr = ` - Error: ${data.message}\nStack: ${data.stack}`;
            } else if (typeof data === 'object') {
                try {
                    dataStr = ` - ${JSON.stringify(data, null, 2)}`;
                } catch (err) {
                    dataStr = ` - ${data.toString()}`;
                }
            } else {
                dataStr = ` - ${data}`;
            }
        }
        
        return `[${timestamp}] [${level}] ${message}${dataStr}\n`;
    }

    log(level, message, data = null) {
        const logMessage = this.formatMessage(level, message, data);
        
        // Write to console
        console.log(logMessage);
        
        // Write to file
        fs.appendFileSync(this.logFile, logMessage);
    }

    info(message, data = null) {
        this.log('INFO', message, data);
    }

    error(message, data = null) {
        const errorData = data instanceof Error ? data : data;
        this.log('ERROR', message, errorData);
        
        // Additional error handling for critical errors
        if (data instanceof Error && data.stack) {
            this.log('ERROR', 'Stack Trace:', data.stack);
        }
    }

    debug(message, data = null) {
        this.log('DEBUG', message, data);
    }

    warn(message, data = null) {
        this.log('WARN', message, data);
    }
}

module.exports = new Logger();