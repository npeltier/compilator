// Google Cast (Chromecast) sender integration.
//
// Chrome / Android Chrome only — the Cast sender framework doesn't exist in
// other browsers (notably iOS Safari), so everything here stays dormant unless
// the SDK loads and reports a receiver. The player drives it: it asks whether a
// device is available, hands off the current track's PUBLIC url + metadata
// (the receiver fetches the audio itself, so it needs the Firebase download URL,
// not a blob:), and routes transport to the receiver while connected.
//
// Public API:
//   initCast(handlers)     — wire the SDK; handlers: { onState, onConnect,
//                            onDisconnect, onTime, onPlayPause, onEnded }
//   isCastReady()          — SDK loaded and a context exists
//   isCasting()            — a receiver session is currently connected
//   requestCastSession()   — open the device picker (call from a click)
//   castTrack({...})       — load a track on the receiver
//   castPlayPause/castSeek/castStop

/* global cast, chrome */

let handlers = {};
let remotePlayer = null;
let remoteController = null;
let ready = false;

export function isCastReady() { return ready; }
export function isCasting() { return !!(ready && remotePlayer && remotePlayer.isConnected); }

export function initCast(cbs = {}) {
  handlers = cbs;
  // The SDK invokes this global once loaded; set it before the script tag runs
  // (script is injected by index.html) so we never miss the callback.
  window.__onGCastApiAvailable = (available) => { if (available) setup(); };
  if (window.cast && window.cast.framework) setup();
}

function stateName() {
  if (!ready) return 'unavailable';
  const s = cast.framework.CastContext.getInstance().getCastState();
  if (s === cast.framework.CastState.CONNECTED) return 'connected';
  if (s === cast.framework.CastState.NO_DEVICES_AVAILABLE) return 'unavailable';
  return 'available'; // NOT_CONNECTED / CONNECTING with a device present
}
function emitState() { handlers.onState?.(stateName()); }

function setup() {
  if (ready) return;
  const context = cast.framework.CastContext.getInstance();
  context.setOptions({
    // Default Media Receiver — plays plain audio/video with no registered app.
    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });

  remotePlayer = new cast.framework.RemotePlayer();
  remoteController = new cast.framework.RemotePlayerController(remotePlayer);

  remoteController.addEventListener(
    cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED,
    () => { (remotePlayer.isConnected ? handlers.onConnect : handlers.onDisconnect)?.(); emitState(); },
  );
  remoteController.addEventListener(
    cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED,
    () => handlers.onTime?.(remotePlayer.currentTime, remotePlayer.duration),
  );
  remoteController.addEventListener(
    cast.framework.RemotePlayerEventType.IS_PAUSED_CHANGED,
    () => handlers.onPlayPause?.(!remotePlayer.isPaused),
  );
  context.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, emitState);

  ready = true;
  emitState();
}

export function requestCastSession() {
  if (!ready) return Promise.reject(new Error('cast not ready'));
  return cast.framework.CastContext.getInstance().requestSession();
}

export async function castTrack({ url, contentType = 'audio/mpeg', title, artist, album, coverUrl, currentTime = 0 }) {
  const session = ready && cast.framework.CastContext.getInstance().getCurrentSession();
  if (!session) return false;
  const mediaInfo = new chrome.cast.media.MediaInfo(url, contentType);
  mediaInfo.metadata = new chrome.cast.media.MusicTrackMediaMetadata();
  mediaInfo.metadata.title = title || '';
  mediaInfo.metadata.artist = artist || '';
  mediaInfo.metadata.albumName = album || '';
  if (coverUrl) mediaInfo.metadata.images = [new chrome.cast.Image(coverUrl)];
  const request = new chrome.cast.media.LoadRequest(mediaInfo);
  request.currentTime = currentTime || 0;
  request.autoplay = true;
  try {
    await session.loadMedia(request);
    // Reliable end-of-track detection: the media reports idleReason FINISHED.
    const media = session.getMediaSession();
    if (media) {
      const listener = () => {
        if (media.idleReason === chrome.cast.media.IdleReason.FINISHED) {
          media.removeUpdateListener(listener);
          handlers.onEnded?.();
        }
      };
      media.addUpdateListener(listener);
    }
    return true;
  } catch (err) {
    console.warn('cast loadMedia failed', err);
    return false;
  }
}

export function castPlayPause() { if (isCasting()) remoteController.playOrPause(); }
export function castSeek(t) {
  if (!isCasting()) return;
  remotePlayer.currentTime = t;
  remoteController.seek();
}
export function castStop() {
  const session = ready && cast.framework.CastContext.getInstance().getCurrentSession();
  session?.endSession(true);
}
