/**
 * Copyright 2015 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {isLayoutSizeDefined} from '../../../src/layout';
import {addParamsToUrl} from '../../../src/url';
import {getDataParamsFromAttributes, removeElement} from '../../../src/dom';
import {dev, user} from '../../../src/log';
import {isObject} from '../../../src/types';
import {
  installVideoManagerForDoc,
} from '../../../src/service/video-manager-impl';
import {VideoEvents} from '../../../src/video-interface';
import {videoManagerForDoc} from '../../../src/video-manager';

const TAG = 'amp-brightcove';

/**
 * @implements {../../../src/video-interface.VideoInterface}
 */
class AmpBrightcove extends AMP.BaseElement {

  /** @param {!AmpElement} element */
  constructor(element) {
    super(element);

    /** @private {?Element} */
    this.iframe_ = null;

    /** @private {?boolean} */
    this.playing_ = false;

    /** @private {?boolean}  */
    this.muted_ = false;

    /** @private {?boolean}  */
    this.hasAmpSupport_ = false;

    /** @private {?Promise} */
    this.playerReadyPromise_ = null;

    /** @private {?Function} */
    this.playerReadyResolver_ = null;

    /** @private {?number} */
    this.readyTimeout_ = null;
  }

  /** @override */
  preconnectCallback() {
    this.preconnect.url('https://players.brightcove.net');
  }

  /** @override */
  isLayoutSupported(layout) {
    return isLayoutSizeDefined(layout);
  }

   /** @override */
   viewportCallback(visible) {
     this.element.dispatchCustomEvent(VideoEvents.VISIBILITY, {visible});
   }

  /** @override */
  buildCallback() {
    this.iframe_ = null;

    this.playerReadyPromise_ = new Promise(resolve => {
      this.playerReadyResolver_ = resolve;
    });

    // Warn if the player does not have video interface support
    this.readyTimeout_ = window.setTimeout(() => {
      user().warn(TAG, 'Ensure player has videojs-amp-support plugin');
    }, 3000);

    this.playerReadyResolver_(this.iframe_);
  }

  /** @override */
  layoutCallback() {
    const account = user().assert(
        this.element.getAttribute('data-account'),
        'The data-account attribute is required for <amp-brightcove> %s',
        this.element);
    const playerid = (this.element.getAttribute('data-player') ||
      this.element.getAttribute('data-player-id') ||
      'default');
    const embed = (this.element.getAttribute('data-embed') || 'default');
    const iframe = this.element.ownerDocument.createElement('iframe');
    let src = `https://players.brightcove.net/${encodeURIComponent(account)}/${encodeURIComponent(playerid)}_${encodeURIComponent(embed)}/index.html`;

    if (this.element.getAttribute('data-playlist-id')) {
      src += '?playlistId=';
      src += this.encodeId_(this.element.getAttribute('data-playlist-id'));
    } else if (this.element.getAttribute('data-video-id')) {
      src += '?videoId=';
      src += this.encodeId_(this.element.getAttribute('data-video-id'));
    }

    // autoplay attribute must be used for autoplay
    user().assert(
      !this.element.hasAttribute('data-param-autoplay'),
      'Do not use data-param-autoplay with <amp-brightcove>, use autoplay instead %s',
      this.element
    );
    this.element.removeAttribute('data-param-autoplay');

    // Players in AMP play inline
    this.element.setAttribute('data-param-playsinline', 'true');

    // Pass through data-param-* attributes as params for plugin use
    src = addParamsToUrl(src, getDataParamsFromAttributes(this.element));
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.src = src;
    this.applyFillContent(iframe);
    this.element.appendChild(iframe);
    this.iframe_ = iframe;

    this.win.addEventListener(
        'message', event => this.handlePlayerMessages_(event));

    return this.loadPromise(iframe)
      .then(() => this.playerReadyPromise_);
  }

  /**
   * Sends a command to the player through postMessage.
   * @param {string} command
   * @param {Object=} opt_args
   * @private
   * */
  // TODO
  sendCommand_(command, opt_args) {
    this.iframe_.contentWindow./*OK*/postMessage(JSON.stringify({
      'command': command,
      'args': opt_args || '',
    }), '*');
  }

  /** @private */
  // TODO
  handlePlayerMessages_(event) {
    if (event.origin != 'https://players.brightcove.net' ||
        event.source != this.iframe_.contentWindow) {
      return;
    }
    if (!event.data ||
        !(isObject(event.data) || event.data.indexOf('{') == 0)) {
      return;  // Doesn't look like JSON.
    }
    const data = isObject(event.data) ? event.data : tryParseJson(event.data);
    if (data === undefined) {
      return; // We only process valid JSON.
    }

    if (data.event) {
      if (data.event === 'ready') {
        dev().info(TAG, `Player ready. Brightcove Player version
          : ${data.bcVersion} AMP Support version: ${data.ampSupportVersion}`);
        window.clearTimeout(this.readyTimeout_);
        this.hasAmpSupport_ = true;
        installVideoManagerForDoc(this.element);
        videoManagerForDoc(this.element).register(this);
        this.element.dispatchCustomEvent(VideoEvents.LOAD);
      }
      // Use play not playing: #7321
      if (data.event === 'play' || data.event === 'pause') {
        if (data.playing !== undefined) {
          this.playing_ = data.playing;
          if (this.playing_) {
            this.element.dispatchCustomEvent(VideoEvents.PLAY);
          } else {
            this.element.dispatchCustomEvent(VideoEvents.PAUSE);
          }
        }
      }
      if (data.event === 'volumechange') {
        if (data.muted !== undefined) {
          this.muted_ = data.muted;
          if (this.muted_) {
            this.element.dispatchCustomEvent(VideoEvents.MUTED);
          } else {
            this.element.dispatchCustomEvent(VideoEvents.UNMUTED);
          }
        }
      }
    }
  }

  /** @private */
  encodeId_(id) {
    /* id is either a Brightcove-assigned id, or a customer-generated reference id.
      reference ids are prefixed 'ref:' and the colon must be preserved unencoded */
    if (id.substring(0,4) === 'ref:') {
      return `ref:${encodeURIComponent(id.substring(4))}`;
    } else {
      return encodeURIComponent(id);
    }
  }

  /** @override */
  pauseCallback() {
    // Only send pauseVideo command if the player is playing. Otherwise
    // The player breaks if the user haven't played the video yet specially
    // on mobile.
    if (this.iframe_ && this.iframe_.contentWindow) {
      if (this.hasAmpSupport_ && this.playing_) {
        this.pause();
      } else {
        // Fallback for players without videojs-amp-support
        // but which use the older plugin
        this.iframe_.contentWindow./*OK*/postMessage(
          'pause', 'https://players.brightcove.net');
      }
    }
  }

  /** @override */
  unlayoutOnPause() {
    if (!this.hasAmpSupport_) {
      return true;
    }
    return false;
  }

  /** @override */
  unlayoutCallback() {
    if (!this.hasAmpSupport_) {
      if (this.iframe_) {
        removeElement(this.iframe_);
        this.iframe_ = null;
      }
      return true;
    }
    return false;
  }

  // VideoInterface Implementation. See ../src/video-interface.VideoInterface

  /**
   * @override
   */
  supportsPlatform() {
    return true;
  }

  /** @override */
  isInteractive() {
    return true;
  }

  /**
   * @override
   */
  play(unusedIsAutoplay) {
    this.playerReadyPromise_.then(() => {
      this.sendCommand_('play');
    });
  }

  /**
   * @override
   */
  pause() {
    this.playerReadyPromise_.then(() => {
      this.sendCommand_('pause');
    });
  }

  /**
   * @override
   */
  mute() {
    this.playerReadyPromise_.then(() => {
      this.sendCommand_('muted', true);
    });
  }

  /**
   * @override
   */
  unmute() {
    this.playerReadyPromise_.then(() => {
      this.sendCommand_('muted', false);
    });
  }

  /**
   * @override
   */
  showControls() {
    this.playerReadyPromise_.then(() => {
      this.sendCommand_('controls', true);
    });
  }

  /**
   * @override
   */
  hideControls() {
    this.sendCommand_('controls', false);
  }
};

AMP.registerElement('amp-brightcove', AmpBrightcove);
