/**
 * Production-ready logging utility
 * Provides structured logging with different levels and error tracking
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const ERROR_LOG_FILE = path.join(LOG_DIR, 'errors.log');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

class Logger {
  constructor() {
    this.logLevels = {
      ERROR: 0,
      WARN: 1,
      INFO: 2,
      DEBUG: 3
    };
    
    this.currentLevel = process.env.LOG_LEVEL ? 
      this.logLevels[process.env.LOG_LEVEL.toUpperCase()] || this.logLevels.INFO : 
      this.logLevels.INFO;
  }

  shouldLog(level) {
    return this.logLevels[level] <= this.currentLevel;
  }

  formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaString = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
    return `[${timestamp}] ${level}: ${message} ${metaString}`;
  }

  writeToFile(filename, message) {
    try {
      fs.appendFileSync(filename, message + '\n');
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  error(message, error = null, meta = {}) {
    if (!this.shouldLog('ERROR')) return;
    
    const formattedMessage = this.formatMessage('ERROR', message, meta);
    console.error(formattedMessage);
    this.writeToFile(LOG_FILE, formattedMessage);
    
    // Also write to error-specific log
    if (error) {
      const errorDetails = {
        message: error.message,
        stack: error.stack,
        code: error.code,
        timestamp: new Date().toISOString()
      };
      const errorMessage = this.formatMessage('ERROR', message, { ...meta, error: errorDetails });
      this.writeToFile(ERROR_LOG_FILE, errorMessage);
    }
  }

  warn(message, meta = {}) {
    if (!this.shouldLog('WARN')) return;
    
    const formattedMessage = this.formatMessage('WARN', message, meta);
    console.warn(formattedMessage);
    this.writeToFile(LOG_FILE, formattedMessage);
  }

  info(message, meta = {}) {
    if (!this.shouldLog('INFO')) return;
    
    const formattedMessage = this.formatMessage('INFO', message, meta);
    console.log(formattedMessage);
    this.writeToFile(LOG_FILE, formattedMessage);
  }

  debug(message, meta = {}) {
    if (!this.shouldLog('DEBUG')) return;
    
    const formattedMessage = this.formatMessage('DEBUG', message, meta);
    console.log(formattedMessage);
    this.writeToFile(LOG_FILE, formattedMessage);
  }

  // Structured logging for API requests
  apiRequest(method, endpoint, userId, statusCode, responseTime, error = null) {
    const logData = {
      method,
      endpoint,
      user_id: userId,
      status_code: statusCode,
      response_time_ms: responseTime,
      timestamp: new Date().toISOString()
    };

    if (error) {
      logData.error = {
        message: error.message,
        stack: error.stack
      };
      this.error(`API Request Failed: ${method} ${endpoint}`, error, logData);
    } else {
      this.info(`API Request: ${method} ${endpoint}`, logData);
    }
  }

  // Structured logging for AI operations
  aiOperation(operation, userId, success, responseTime, error = null) {
    const logData = {
      operation,
      user_id: userId,
      success,
      response_time_ms: responseTime,
      timestamp: new Date().toISOString()
    };

    if (error) {
      logData.error = {
        message: error.message,
        code: error.code
      };
      this.error(`AI Operation Failed: ${operation}`, error, logData);
    } else {
      this.info(`AI Operation: ${operation}`, logData);
    }
  }

  // Structured logging for scraping operations
  scrapingOperation(operation, itemCount, success, responseTime, error = null) {
    const logData = {
      operation,
      items_processed: itemCount,
      success,
      response_time_ms: responseTime,
      timestamp: new Date().toISOString()
    };

    if (error) {
      logData.error = {
        message: error.message,
        code: error.code
      };
      this.error(`Scraping Failed: ${operation}`, error, logData);
    } else {
      this.info(`Scraping Success: ${operation}`, logData);
    }
  }
}

module.exports = new Logger();
