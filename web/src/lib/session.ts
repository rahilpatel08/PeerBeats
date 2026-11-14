import { stopSharing } from '../p2p/contributor';
import { closeSocket } from '../p2p/socket';
import { stopPlayback } from '../player/engine';
import { useAuth } from '../store/auth';

export function endSession() {
  stopPlayback();
  stopSharing();
  closeSocket();
  useAuth.getState().logout();
}
