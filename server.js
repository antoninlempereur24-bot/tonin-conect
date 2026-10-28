function pgConfig() {
  const raw = String(process.env.DATABASE_URL || '').trim();
  if (!raw) throw new Error('DATABASE_URL est vide : impossible de se connecter à PostgreSQL.');
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error('DATABASE_URL est invalide (vérifie le lien copié depuis Supabase).'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('DATABASE_URL doit commencer par postgresql://');
  if (!u.hostname) throw new Error('DATABASE_URL ne contient pas d\'adresse de serveur.');
  const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(u.hostname);
  if (isLocal && IS_PROD) throw new Error('DATABASE_URL pointe vers localhost en production : refusé.');
  return {
    host: u.hostname,
    port: Number(u.port) || 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
    // Supabase : certificat accepté même s'il n'est pas dans la liste du système
    ssl: process.env.PGSSL === 'disable' && !IS_PROD ? false : { rejectUnauthorized: false },
    family: 4, // Force IPv4 pour éviter les erreurs réseau sur Render
    max: 5,
    connectionTimeoutMillis: 15000,
  };
}
