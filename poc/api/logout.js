// GET /api/logout -> clears the access cookie and returns to the login page.
module.exports = (req, res) => {
  res.setHeader('Set-Cookie', 'kpw_auth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
  res.writeHead(302, { Location: '/login' });
  res.end();
};
