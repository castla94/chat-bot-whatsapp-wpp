import winston from 'winston';
import WinstonCloudWatch from 'winston-cloudwatch';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
dotenv.config();

// Crear una función para obtener el nombre del stream
const getLogStreamName = (prefix = 'app') => {
    const date = new Date().toISOString().split('T')[0];
    const emailToken = process.env.EMAIL_TOKEN?.toString() || 'unknown';
    return `${emailToken}-${prefix}-${date}`;
};

// Crear el logger con opciones configurables
export const createCloudWatchLogger = (options = {}) => {
    const {
        logGroupName = 'whatsapp-bot-logs',
        prefix = 'app',
        region = process.env.AWS_REGION || 'us-east-1',
        // Permitir configuraciones adicionales
        additionalOptions = {}
    } = options;

    const fileTransports = [];
    if (process.env.LOG_TO_FILE !== 'false') {
        const directory = path.resolve(process.env.LOG_DIRECTORY || 'logs');
        fs.mkdirSync(directory, { recursive: true });
        fileTransports.push(new winston.transports.File({
            filename: path.join(directory, 'bot.log'), maxsize: 10 * 1024 * 1024, maxFiles: 3,
        }));
    }
    return winston.createLogger({
        level: process.env.LOG_LEVEL || 'info',
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
        ),
        transports: [
            // Mantener logs en consola para desarrollo
            new winston.transports.Console({
                format: winston.format.printf(({ timestamp, level, message, ...metadata }) =>
                    `${timestamp} ${level.toUpperCase()} ${message} ${JSON.stringify(metadata)}`)
            }),
            ...fileTransports,
            // Configurar CloudWatch
            ...(process.env.CLOUDWATCH_ENABLED === 'false' ? [] : [new WinstonCloudWatch({
                logGroupName,
                logStreamName: getLogStreamName(prefix),
                awsRegion: region,
                messageFormatter: ({ level, message, timestamp, ...additionalInfo }) => {
                    return JSON.stringify({
                        timestamp,
                        level,
                        message,
                        project: process.env.EMAIL_TOKEN,
                        ...additionalInfo
                    });
                },
                ...additionalOptions
            })])
        ]
    });
};

// Crear una instancia por defecto
export const defaultLogger = createCloudWatchLogger();
