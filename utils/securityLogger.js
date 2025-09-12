
const fs = require('fs').promises;
const path = require('path');

class SecurityLogger {
    constructor() {
        this.logFile = path.join(__dirname, '../logs/security.log');
        this.ensureLogDirectory();
    }

    async ensureLogDirectory() {
        try {
            const logDir = path.dirname(this.logFile);
            await fs.mkdir(logDir, { recursive: true });
        } catch (error) {
            console.error('Failed to create log directory:', error);
        }
    }

    async log(level, event, details = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level: level.toUpperCase(),
            event,
            details,
            ip: details.ip || 'unknown',
            userAgent: details.userAgent || 'unknown'
        };

        const logLine = JSON.stringify(logEntry) + '\n';

        try {
            await fs.appendFile(this.logFile, logLine);
        } catch (error) {
            console.error('Failed to write security log:', error);
        }

        // Also log to console for immediate visibility
        const levelColors = {
            INFO: '\x1b[36m',    // Cyan
            WARN: '\x1b[33m',    // Yellow
            ERROR: '\x1b[31m',   // Red
            CRITICAL: '\x1b[35m' // Magenta
        };

        const color = levelColors[level.toUpperCase()] || '\x1b[0m';
        const reset = '\x1b[0m';
        
        console.log(`${color}[SECURITY ${level.toUpperCase()}]${reset} ${event} - IP: ${details.ip || 'unknown'}`);
    }

    async info(event, details = {}) {
        await this.log('info', event, details);
    }

    async warn(event, details = {}) {
        await this.log('warn', event, details);
    }

    async error(event, details = {}) {
        await this.log('error', event, details);
    }

    async critical(event, details = {}) {
        await this.log('critical', event, details);
    }

    async getRecentLogs(hours = 24) {
        try {
            const logContent = await fs.readFile(this.logFile, 'utf-8');
            const lines = logContent.trim().split('\n').filter(line => line);
            const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);

            return lines
                .map(line => {
                    try {
                        return JSON.parse(line);
                    } catch {
                        return null;
                    }
                })
                .filter(entry => entry && new Date(entry.timestamp) > cutoffTime)
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        } catch (error) {
            console.error('Failed to read security logs:', error);
            return [];
        }
    }
}

module.exports = new SecurityLogger();
