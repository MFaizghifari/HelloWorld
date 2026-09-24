// Team roles, shared by the builder (what to show) and the Worker (what to
// allow). The Worker is the one that enforces them; the UI only hides what a
// role cannot use.

export const ROLES = {
  owner: { label: 'Pemilik', rank: 4, desc: 'Semua akses, termasuk mengelola tim. Hanya satu orang.' },
  admin: { label: 'Admin', rank: 3, desc: 'Membuat dan menerbitkan form, melihat hasil, mengelola anggota tim.' },
  editor: { label: 'Editor', rank: 2, desc: 'Membuat, mengedit, dan menerbitkan form, termasuk Pixel dan uji A/B. Melihat hasil.' },
  viewer: { label: 'Pembaca', rank: 1, desc: 'Melihat hasil, jawaban, dan file yang diunggah. Tidak bisa mengubah form.' },
};

/** Minimum role per permission. */
export const PERMISSIONS = {
  'results.view': 'viewer', // Hasil, jawaban, file, ekspor CSV
  'forms.edit': 'editor', // simpan/terbitkan/hapus form, integrasi, uji A/B, unggah gambar
  'team.manage': 'admin', // undang, ubah peran, hapus anggota, lihat aktivitas
};

export function can(role, permission) {
  const need = ROLES[PERMISSIONS[permission]];
  return !!need && (ROLES[role]?.rank || 0) >= need.rank;
}

/** Roles someone with `role` may hand out. Nobody hands out "owner" except by transfer. */
export function assignableRoles(role) {
  if (role === 'owner') return ['admin', 'editor', 'viewer'];
  if (role === 'admin') return ['admin', 'editor', 'viewer'];
  return [];
}

/** Whether `actor` may change or remove `target` (both role names). */
export function canManage(actor, target) {
  if (!can(actor, 'team.manage')) return false;
  if (target === 'owner') return false;
  return true;
}

/** Tabs of the builder a role can open. */
export function allowedTabs(role) {
  return can(role, 'forms.edit') ? ['content', 'logic', 'connect', 'share', 'ab', 'results'] : ['share', 'ab', 'results'];
}

// NIST SP 800-63B §5.1.1.2: at least 8 characters, no composition rules, allow long passphrases.
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < PASSWORD_MIN) return `Kata sandi minimal ${PASSWORD_MIN} karakter.`;
  if (s.length > PASSWORD_MAX) return `Kata sandi maksimal ${PASSWORD_MAX} karakter.`;
  return null;
}

export function initials(name, email = '') {
  const words = String(name || email.split('@')[0] || '').match(/\p{L}[\p{L}\p{N}]*/gu) || ['?'];
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}
