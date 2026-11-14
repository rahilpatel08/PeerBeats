import type { User } from './types';

export type Role = 'admin' | 'contributor' | 'listener';

/** Each person uses PeerBeats in one way at a time, and sees only that menu. */
export const roleOf = (user: User): Role => (user.isAdmin ? 'admin' : user.isContributor ? 'contributor' : 'listener');

/** Where each role starts. */
export const homeOf = (role: Role) => (role === 'contributor' ? '/share' : '/');
