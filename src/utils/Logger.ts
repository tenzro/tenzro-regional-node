// // tenzro-regional-node/utils/Logger.ts

/**
 * This class provides a singleton implementation of a logger. 
 * It allows setting a context for log messages and provides methods for logging 
 * information at different levels (info, error, warn, debug).
 */
export class Logger {
    private static instance: Logger;
    private context: string = 'Global'; 
  
    /**
     * Private constructor to prevent direct instantiation.
     */
    private constructor() {}
  
    /**
     * Gets the singleton instance of the Logger.
     * 
     * @returns The singleton Logger instance.
     */
    static getInstance(): Logger {
      if (!Logger.instance) {
        Logger.instance = new Logger();
      }
      return Logger.instance;
    }
  
    /**
     * Sets the context for the logger. This will be included in each log message.
     * 
     * @param context The context for the logger.
     */
    setContext(context: string): void {
      this.context = context;
    }
  
    /**
     * Logs an informational message.
     * 
     * @param message The message to log.
     * @param meta Optional metadata to include with the message.
     */
    info(message: string, meta?: any): void {
      console.log(this.format('INFO', message, meta));
    }
  
    /**
     * Logs an error message.
     * 
     * @param message The message to log.
     * @param error The error object to log.
     * @param meta Optional metadata to include with the message.
     */
    error(message: string, error?: Error, meta?: any): void {
      console.error(this.format('ERROR', message, { ...meta, error: error?.stack }));
    }
  
    /**
     * Logs a warning message.
     * 
     * @param message The message to log.
     * @param meta Optional metadata to include with the message.
     */
    warn(message: string, meta?: any): void {
      console.warn(this.format('WARN', message, meta));
    }
  
    /**
     * Logs a debug message. Only logged in development environment.
     * 
     * @param message The message to log.
     * @param meta Optional metadata to include with the message.
     */
    debug(message: string, meta?: any): void {
      if (process.env.NODE_ENV === 'development') {
        console.debug(this.format('DEBUG', message, meta));
      }
    }
  
    /**
     * Formats the log message with timestamp, level, context, and optional metadata.
     * 
     * @param level The log level (e.g., 'INFO', 'ERROR').
     * @param message The log message.
     * @param meta Optional metadata to include with the message.
     * @returns The formatted log message.
     */
    private format(level: string, message: string, meta?: any): string {
      const timestamp = new Date().toISOString();
      const baseMessage = `[${timestamp}] [${level}] [${this.context}] ${message}`;
      return meta ? `${baseMessage} ${JSON.stringify(meta)}` : baseMessage;
    }
  }
  
  // Export the singleton instance of the Logger for easy access.
  export default Logger.getInstance();