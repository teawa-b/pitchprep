// Vercel runs the backend as one function; vercel.json sends every request here.
import { createApp } from '../backend/server.js';

const app = createApp();
export default (req, res) => app(req, res);
