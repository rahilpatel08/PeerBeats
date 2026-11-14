import { io, type Socket } from 'socket.io-client';
import { useAuth } from '../store/auth';

let socket: Socket | null = null;
let socketToken: string | null = null;

/** One connection per tab, shared by the listener, contributor and monitor code. */
export function getSocket(): Socket {
  const token = useAuth.getState().token;
  if (socket && socketToken === token) return socket;
  socket?.disconnect();
  socketToken = token;
  socket = io({ auth: { token } });
  return socket;
}

export function closeSocket() {
  socket?.disconnect();
  socket = null;
  socketToken = null;
}
