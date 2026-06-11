import pino from "pino";
import { config } from "../config/env.js";

const loggerOptions = {
  level: config.LOG_LEVEL,
  base: {
    service: "sag"
  },
};

export const logger = process.env.SAG_LOG_STDERR === "true"
  ? pino(loggerOptions, pino.destination(2))
  : pino(loggerOptions);
