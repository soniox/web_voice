"use strict";

/*
audio-recorder-polyfill license:

The MIT License (MIT)

Copyright 2017 Andrey Sitnik <andrey@sitnik.ru>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
const audioRecorderPolyfill = new (function () {
  let pcm_s16leEncoder = function () {
    let buffers = [];
    let initialZeros = true;

    function encode(buffer, removeInitialZeros) {
      let length = buffer.length;
      let array = new Uint8Array(length * 2);
      let view = new DataView(array.buffer);
      for (let i = 0; i < length; i++) {
        let sample = Math.max(
          -32768,
          Math.min(32767, Math.floor(buffer[i] * 32768))
        );
        let byteOffset = i * 2;
        view.setInt16(byteOffset, sample, true);
      }
      if (removeInitialZeros && initialZeros) {
        let i = 0;
        while (i < length && view.getInt16(i * 2) == 0) {
          i++;
        }
        if (i == length) {
          return;
        }
        if (i > 0) {
          buffer = buffer.slice(i);
        }
        initialZeros = false;
      }
      buffers.push(array);
    }

    function dump(maxOutputSize, removeInitialZeros) {
      let outputBuffers = [];
      let buffersPos = 0;

      while (buffersPos < buffers.length) {
        let numBuffers = 0;
        let length = 0;

        while (buffersPos + numBuffers < buffers.length) {
          let buffer = buffers[buffersPos + numBuffers];
          if (numBuffers > 0 && length + buffer.length > maxOutputSize) {
            break;
          }
          ++numBuffers;
          length += buffer.length;
        }

        let array = new Uint8Array(length);
        let offset = 0;

        for (let i = 0; i < numBuffers; ++i) {
          let buffer = buffers[buffersPos + i];
          array.set(buffer, offset);
          offset += buffer.length;
        }

        buffersPos += numBuffers;
        outputBuffers.push(array.buffer);
      }

      if (outputBuffers.length == 0 && removeInitialZeros && initialZeros) {
        outputBuffers.push(new ArrayBuffer(0));
      }

      buffers = [];

      return outputBuffers;
    }

    onmessage = (e) => {
      var cmd = e.data[0];
      if (cmd === "encode") {
        encode(e.data[1], e.data[2]);
      } else if (cmd === "dump") {
        let outputBuffers = dump(e.data[1], e.data[2]);
        for (let i = 0; i < outputBuffers.length; ++i) {
          let buf = outputBuffers[i];
          postMessage(["data", buf], [buf]);
        }
      } else if (cmd === "end") {
        postMessage(["end", null]);
        buffers = [];
        initialZeros = true;
      }
    };
  };

  let AudioContext = window.AudioContext || window.webkitAudioContext;

  function createWorker(fn) {
    let js = fn
      .toString()
      .replace(/^(\(\)\s*=>|function\s*\(\))\s*{/, "")
      .replace(/}$/, "");
    let blob = new Blob([js]);
    return new Worker(URL.createObjectURL(blob));
  }

  let context, processor;

  /**
   * Audio Recorder with MediaRecorder API.
   *
   * @example
   * navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
   *   let recorder = new MediaRecorder(stream)
   * })
   */
  class MediaRecorder {
    static getAudioContext() {
      if (!context) {
        context = new AudioContext();
      }
      return context;
    }

    /**
     * @param streamOrElemSource The MediaStream stream, or the
     * MediaElementAudioSourceNode, to record. Note that in the latter case,
     * the browser will not play the audio on its own (set playBack=true to
     * make this class ensure that audio is played).
     */
    constructor(streamOrElemSource) {
      console.assert(
        streamOrElemSource instanceof MediaStream ||
          streamOrElemSource instanceof MediaElementAudioSourceNode
      );

      this.streamOrElemSource = streamOrElemSource;

      /**
       * The current state of recording process.
       * @type {"inactive"|"recording"}
       */
      this.state = "inactive";

      // Ensure that the AudioContext is created. This is so that
      // getSampleRate() works.
      MediaRecorder.getAudioContext();

      this.em = document.createDocumentFragment();
      this.encoder = createWorker(MediaRecorder.encoder);

      let recorder = this;
      this.encoder.addEventListener("message", (e) => {
        let event = new Event(e.data[0]);
        event.data = e.data[1];
        recorder.em.dispatchEvent(event);
      });
    }

    /**
     * Begins recording media.
     *
     * @param timeslice Time interval in milliseconds for returning buffered
     * data. If falsey, data will only be returned after stop().
     * @param maxOutputSize Maximum output buffer size in bytes.
     * @param playBack If true, the audio will be played back.
     * @param removeInitialZeros If true, initial zero samples will not be
     * included in returned data. In this case, empty data buffers will
     * be periodically returned until the end of initial zeros.
     *
     * @example
     * recordButton.addEventListener('click', () => {
     *   recorder.start()
     * })
     */
    start(
      timeslice,
      maxOutputSize,
      playBack = false,
      removeInitialZeros = false
    ) {
      if (this.state !== "inactive") {
        throw "recorder is active";
      }

      this.state = "recording";
      this.maxOutputSize = maxOutputSize;
      this.playBack = playBack;
      this.removeInitialZeros = removeInitialZeros;

      if (this.streamOrElemSource instanceof MediaElementAudioSourceNode) {
        this.input = this.streamOrElemSource;
      } else {
        this.clone = this.streamOrElemSource.clone();
        this.input = context.createMediaStreamSource(this.clone);
      }

      if (!processor) {
        processor = context.createScriptProcessor(2048, 1, 1);
      }

      let recorder = this;
      processor.onaudioprocess = function (e) {
        if (recorder.state === "recording") {
          recorder.encoder.postMessage([
            "encode",
            e.inputBuffer.getChannelData(0),
            this.removeInitialZeros,
          ]);
        }
      };

      this.input.connect(processor);
      processor.connect(context.destination);
      if (this.playBack) {
        this.input.connect(context.destination);
      }

      if (timeslice) {
        this.slicing = setInterval(() => {
          if (recorder.state === "recording") {
            this._postEncoderDump();
          }
        }, timeslice);
      } else {
        this.slicing = null;
      }
    }

    getSampleRate() {
      return context.sampleRate;
    }

    terminateWorker() {
      this.encoder.terminate();
    }

    /**
     * Stop media capture and flush.
     * Any further "data" events and the "end" event will be
     * reported asynchonously.
     *
     * @return {undefined}
     *
     * @example
     * finishButton.addEventListener('click', () => {
     *   recorder.stop()
     * })
     */
    stop() {
      if (this.state === "inactive") {
        return;
      }

      this.state = "inactive";

      if (this.slicing) {
        clearInterval(this.slicing);
        this.slicing = null;
      }

      // Send the encoder the dump command and then the end command
      // to flush remaining buffered data end report end afterward.
      this._postEncoderDump();
      this.encoder.postMessage(["end"]);

      if (this.clone) {
        this.clone.getTracks().forEach((track) => {
          track.stop();
        });
        this.clone = null;
      }

      if (this.playBack) {
        this.input.disconnect(context.destination);
      }
      processor.disconnect(context.destination);
      this.input.disconnect(processor);

      this.input = null;
    }

    /**
     * Add listener for specified event type.
     *
     * @param {"data"|"end"}
     * type Event type.
     * @param {function} listener The listener function.
     *
     * @return {undefined}
     *
     * @example
     * recorder.addEventListener('data', e => {
     *   audio.src = URL.createObjectURL(e.data)
     * })
     */
    addEventListener(...args) {
      this.em.addEventListener(...args);
    }

    /**
     * Remove event listener.
     *
     * @param {"data"|"end"}
     * type Event type.
     * @param {function} listener The same function used in `addEventListener`.
     *
     * @return {undefined}
     */
    removeEventListener(...args) {
      this.em.removeEventListener(...args);
    }

    /**
     * Calls each of the listeners registered for a given event.
     *
     * @param {Event} event The event object.
     *
     * @return {boolean} Is event was no canceled by any listener.
     */
    dispatchEvent(...args) {
      this.em.dispatchEvent(...args);
    }

    _postEncoderDump() {
      this.encoder.postMessage([
        "dump",
        this.maxOutputSize,
        this.removeInitialZeros,
      ]);
    }
  }

  /**
   * `true` if MediaRecorder can not be polyfilled in the current browser.
   * @type {boolean}
   *
   * @example
   * if (MediaRecorder.notSupported) {
   *   showWarning('Audio recording is not supported in this browser')
   * }
   */
  MediaRecorder.notSupported = !navigator.mediaDevices || !AudioContext;

  /**
   * Converts RAW audio buffer to compressed audio files.
   * It will be loaded to Web Worker.
   * @type {function}
   */
  MediaRecorder.encoder = pcm_s16leEncoder;

  this.MediaRecorder = MediaRecorder;
})();

export { audioRecorderPolyfill };
