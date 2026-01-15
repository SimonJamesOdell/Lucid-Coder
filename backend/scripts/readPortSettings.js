import { getPortSettings } from '../database.js';

const settings = await getPortSettings();
console.log('getPortSettings():', settings);
