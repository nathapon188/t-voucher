import { handleApi } from '../../server/api.js';

// Netlify Function serving every /api/* request.
// NETLIFY_DB_URL is set automatically once Netlify DB is added to the site.
export default async request => handleApi(request);

export const config = { path: '/api/*' };
