#!/usr/bin/env node
import { createCli } from './cli.js';

void createCli().runExit(process.argv.slice(2));
