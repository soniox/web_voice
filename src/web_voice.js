"use strict";

import { audioRecorderPolyfill } from "./audio_recorder.js";

const DefaultWebSocketUri = "wss://api.soniox.com/transcribe-websocket";
const RecorderTimeSlice_ms = 120;
const MaxOutputSize_B = 60000;
const StatusMessageRegex = new RegExp("^<([a-zA-Z0-9_\\-]+)> *(([^ ]|$).*)$");

const State = Object.freeze({
  Init: "Init",
  RequestingMedia: "RequestingMedia",
  OpeningWebSocket: "OpeningWebSocket",
  Running: "Running",
  FinishingRecording: "FinishingRecording",
  FinishingProcessing: "FinishingProcessing",
  FinishingEarly: "FinishingEarly",
  Finished: "Finished",
  Error: "Error",
  Canceled: "Canceled",
});

const ToUserStateMap = Object.freeze({
  Init: "Init",
  RequestingMedia: "Starting",
  OpeningWebSocket: "Starting",
  Running: "Running",
  FinishingRecording: "Finishing",
  FinishingProcessing: "Finishing",
  FinishingEarly: "Finishing",
  Finished: "Finished",
  Error: "Error",
  Canceled: "Canceled",
});

function isInactiveState(state) {
  return (
    state == State.Init ||
    state == State.Finished ||
    state == State.Error ||
    state == State.Canceled
  );
}

function isWebSocketState(state) {
  return (
    state == State.OpeningWebSocket ||
    state == State.Running ||
    state == State.FinishingRecording ||
    state == State.FinishingProcessing
  );
}

function wordFromJson(jsWord, isFinal) {
  return Object.freeze({
    text: jsWord.t,
    start_ms: jsWord.s,
    duration_ms: jsWord.d,
    speaker: jsWord.spk,
    is_final: isFinal,
  });
}

function resultFromResponse(response) {
  let words = [];
  response.fw.forEach(function (jsWord) {
    words.push(wordFromJson(jsWord, true));
  });
  response.nfw.forEach(function (jsWord) {
    words.push(wordFromJson(jsWord, false));
  });
  let speakers = new Map();
  if (Object.prototype.hasOwnProperty.call(response, "spks")) {
    response.spks.forEach(function (jsSpeaker) {
      speakers.set(jsSpeaker.spk, { speaker: jsSpeaker.spk, name: jsSpeaker.nm });
    });
  }
  const result = {
    words: Object.freeze(words),
    final_proc_time_ms: response.fpt,
    total_proc_time_ms: response.tpt,
    speakers: Object.freeze(speakers),
  };
  return Object.freeze(result);
}

function initialResult() {
  return {
    words: [],
    final_proc_time_ms: 0,
    total_proc_time_ms: 0,
    speakers: Object.freeze(new Map()),
  };
}

let recordTranscribeActive = false;

export class RecordTranscribe {
  constructor() {
    if (RecordTranscribe.notSupported) {
      throw "Soniox Web Voice is not supported on this browser.";
    }

    this._state = State.Init;
    this._apiKey = null;
    this._includeNonFinal = false;
    this._enableEndpointDetection = false;
    this._speechContext = {};
    this._enableStreamingSpeakerDiarization = false;
    this._enableGlobalSpeakerDiarization = false;
    this._minNumSpeakers = 0;
    this._maxNumSpeakers = 0;
    this._enableSpeakerIdentification = false;
    this._candSpeakerNames = [];
    this._enableProfanityFilter = false;
    this._contentModerationPhrases = [];
    this._model = "";
    this._enableDictation = false;
    this._onStarted = null;
    this._onPartialResult = null;
    this._onFinished = null;
    this._onError = null;
    this._webSocketUri = DefaultWebSocketUri;
    this._stream = null;
    this._mediaRecorder = null;
    this._mediaRecorderOnData = null;
    this._mediaRecorderOnEnd = null;
    this._webSocket = null;
    this._result = initialResult();
    this._queuedMessages = null;
  }

  setApiKey(apiKey) {
    if (this._state != State.Init) {
      throw "setApiKey() may only be called before start()";
    }
    this._apiKey = apiKey;
  }

  setIncludeNonFinal(includeNonFinal) {
    if (this._state != State.Init) {
      throw "setIncludeNonFinal() may only be called before start()";
    }
    this._includeNonFinal = includeNonFinal;
  }

  setEnableEndpointDetection(enableEndpointDetection) {
    if (this._state != State.Init) {
      throw "setEnableEndpointDetection() may only be called before start()";
    }
    this._enableEndpointDetection = enableEndpointDetection;
  }

  setSpeechContext(speechContext) {
    if (this._state != State.Init) {
      throw "setSpeechContext() may only be called before start()";
    }
    this._speechContext = speechContext;
  }

  setEnableStreamingSpeakerDiarization(enable) {
    if (this._state != State.Init) {
      throw "setEnableStreamingSpeakerDiarization() may only be called before start()";
    }
    this._enableStreamingSpeakerDiarization = enable;
  }

  setEnableGlobalSpeakerDiarization(enable) {
    if (this._state != State.Init) {
      throw "setEnableGlobalSpeakerDiarization() may only be called before start()";
    }
    this._enableGlobalSpeakerDiarization = enable;
  }

  setMinNumSpeakers(value) {
    if (this._state != State.Init) {
      throw "setMinNumSpeakers() may only be called before start()";
    }
    this._minNumSpeakers = value;
  }

  setMaxNumSpeakers(value) {
    if (this._state != State.Init) {
      throw "setMaxNumSpeakers() may only be called before start()";
    }
    this._maxNumSpeakers = value;
  }

  setEnableSpeakerIdentification(enable) {
    if (this._state != State.Init) {
      throw "setEnableSpeakerIdentification() may only be called before start()";
    }
    this._enableSpeakerIdentification = enable;
  }

  setCandSpeakerNames(candSpeakerNames) {
    if (this._state != State.Init) {
      throw "setCandSpeakerNames() may only be called before start()";
    }
    this._candSpeakerNames = candSpeakerNames;
  }

  setEnableProfanityFilter(enable) {
    if (this._state != State.Init) {
      throw "setEnableProfanityFilter() may only be called before start()";
    }
    this._enableProfanityFilter = enable;
  }

  setContentModerationPhrases(contentModerationPhrases) {
    if (this._state != State.Init) {
      throw "setContentModerationPhrases() may only be called before start()";
    }
    this._contentModerationPhrases = contentModerationPhrases;
  }
  
  setModel(modelName) {
    if (this._state != State.Init) {
      throw "setModel() may only be called before start()";
    }
    this._model = modelName;
  }

  setEnableDictation(enable) {
    if (this._state != State.Init) {
      throw "setEnableDictation() may only be called before start()";
    }
    this._enableDictation = enable;
  }

  setOnStarted(onStarted) {
    if (this._state != State.Init) {
      throw "setOnStarted() may only be called before start()";
    }
    this._onStarted = onStarted;
  }

  setOnPartialResult(onPartialResult) {
    if (this._state != State.Init) {
      throw "setOnPartialResult() may only be called before start()";
    }
    this._onPartialResult = onPartialResult;
  }

  setOnFinished(onFinished) {
    if (this._state != State.Init) {
      throw "setOnFinished() may only be called before start()";
    }
    this._onFinished = onFinished;
  }

  setOnError(onError) {
    if (this._state != State.Init) {
      throw "setOnError() may only be called before start()";
    }
    this._onError = onError;
  }

  setWebSocketUri(webSocketUri) {
    if (this._state != State.Init) {
      throw "setWebSocketUri() may only be called before start()";
    }
    this._webSocketUri = webSocketUri;
  }

  start() {
    if (this._state != State.Init) {
      throw "start() may only be called once";
    }
    if (recordTranscribeActive) {
      throw "only one RecordTranscribe may be active at a time";
    }
    if (this._apiKey == null) {
      throw "API key not set, call setApiKey first";
    }
    const constraints = { audio: true };
    navigator.mediaDevices
      .getUserMedia(constraints)
      .then(
        this._onGetUserMediaSuccess.bind(this),
        this._onGetUserMediaError.bind(this)
      );
    recordTranscribeActive = true;
    this._state = State.RequestingMedia;
  }

  stop() {
    if (
      this._state == State.RequestingMedia ||
      this._state == State.OpeningWebSocket
    ) {
      this._closeResources();
      Promise.resolve(true).then(this._completeFinishingEarly.bind(this));
      this._state = State.FinishingEarly;
    } else if (this._state == State.Running) {
      console.assert(this._mediaRecorder.state == "recording");
      this._stopRecording();
      this._state = State.FinishingRecording;
    }
  }

  cancel() {
    if (!isInactiveState(this._state)) {
      this._closeResources();
      this._state = State.Canceled;
      recordTranscribeActive = false;
    }
  }

  getResult() {
    return this._result;
  }

  getResultCopy() {
    let result = this._result;
    return Object.freeze({
      words: Object.freeze(result.words.slice()),
      final_proc_time_ms: result.final_proc_time_ms,
      total_proc_time_ms: result.total_proc_time_ms,
      speakers: result.speakers,
    });
  }

  getState() {
    return ToUserStateMap[this._state];
  }

  _onGetUserMediaSuccess(stream) {
    // We are responsible for stopping tracks on the media stream at the
    // appropriate time, else the browser will consider that we are still
    // recording.
    if (this._state != State.RequestingMedia) {
      this._stopTracks(stream);
      return;
    }
    this._stream = stream;
    this._mediaRecorder = new audioRecorderPolyfill.MediaRecorder(
      stream
    );
    this._mediaRecorderOnData = this._onMediaRecorderData.bind(this);
    this._mediaRecorderOnEnd = this._onMediaRecorderEnd.bind(this);
    this._mediaRecorder.addEventListener("data", this._mediaRecorderOnData);
    this._mediaRecorder.addEventListener("end", this._mediaRecorderOnEnd);
    this._startRecording();
    this._webSocket = new WebSocket(this._webSocketUri);
    this._webSocket.onopen = this._onWebSocketOpen.bind(this);
    this._webSocket.onclose = this._onWebSocketClose.bind(this);
    this._webSocket.onerror = this._onWebSocketError.bind(this);
    this._webSocket.onmessage = this._onWebSocketMessage.bind(this);
    this._queuedMessages = [];
    this._state = State.OpeningWebSocket;
  }

  _startRecording() {
    this._mediaRecorder.start(
      RecorderTimeSlice_ms,
      MaxOutputSize_B,
      /*playBack=*/false,
      /*removeInitialZeros=*/false,
    );
  }

  _stopRecording() {
    this._mediaRecorder.stop();
  }

  _onGetUserMediaError() {
    if (this._state != State.RequestingMedia) {
      return;
    }
    this._handleError("get_user_media_failed", "Failed to get user media.");
  }

  _onMediaRecorderData(event) {
    if (this._state == State.OpeningWebSocket) {
      if (this._queuedMessages.length < 100) {
        this._queuedMessages.push(event.data);
      } else {
        console.error("max queuedMessages size exceeded");
      }
    } else if (
      this._state == State.Running ||
      this._state == State.FinishingRecording
    ) {
      this._webSocket.send(event.data);
    }
  }

  _onMediaRecorderEnd(event) {
    if (this._state == State.FinishingRecording) {
      this._closeMedia();
      this._webSocket.send("");
      this._state = State.FinishingProcessing;
    }
  }

  _onWebSocketOpen(event) {
    if (this._state != State.OpeningWebSocket) {
      return;
    }
    let request = {
      api_key: this._apiKey,
      sample_rate_hertz: Math.round(this._mediaRecorder.getSampleRate()),
      include_nonfinal: this._includeNonFinal,
      speech_context: this._speechContext,
    };
    if (this._enableEndpointDetection) {
      request["enable_endpoint_detection"] = true;
    }
    if (this._enableStreamingSpeakerDiarization) {
      request["enable_streaming_speaker_diarization"] = true;
    }
    if (this._enableGlobalSpeakerDiarization) {
      request["enable_global_speaker_diarization"] = true;
    }
    if (this._minNumSpeakers !== 0) {
      request["min_num_speakers"] = this._minNumSpeakers;
    }
    if (this._maxNumSpeakers !== 0) {
      request["max_num_speakers"] = this._maxNumSpeakers;
    }
    if (this._enableSpeakerIdentification) {
      request["enable_speaker_identification"] = true;
      request["cand_speaker_names"] = this._candSpeakerNames;
    }
    if (this._enableProfanityFilter) {
      request["enable_profanity_filter"] = true;
    }
    if (this._contentModerationPhrases.length != 0) {
      request["content_moderation_phrases"] = this._contentModerationPhrases;
    }
    if (this._enableDictation) {
      request["enable_dictation"] = true;
    }
    if (this._model) {
      request["model"] = this._model;
    }
    this._webSocket.send(JSON.stringify(request));
    for (let i = 0; i < this._queuedMessages.length; ++i) {
      this._webSocket.send(this._queuedMessages[i]);
    }
    this._queuedMessages = null;
    this._state = State.Running;
    if (this._onStarted != null) {
      this._onStarted();
    }
  }

  _onWebSocketClose(event) {
    if (!isWebSocketState(this._state)) {
      return;
    }
    let status;
    let message;
    if (event.code == 1000) {
      const match = StatusMessageRegex.exec(event.reason);
      if (match != null) {
        status = match[1];
        message = match[2];
        if (status == "eof") {
          if (this._state == State.FinishingProcessing) {
            this._handleFinished();
            return;
          }
          status = "other_asr_error";
          message = "Unexpected EOF received.";
        }
      } else {
        status = "other_asr_error";
        message = event.reason;
      }
    } else {
      status = "websocket_closed";
      message =
        "WebSocket closed: code=" + event.code + ", reason=" + event.reason;
    }
    this._handleError(status, message);
  }

  _onWebSocketError(event) {
    if (!isWebSocketState(this._state)) {
      return;
    }
    this._handleError("websocket_error", "WebSocket error occurred.");
  }

  _onWebSocketMessage(event) {
    if (
      this._state != State.Running &&
      this._state != State.FinishingRecording &&
      this._state != State.FinishingProcessing
    ) {
      return;
    }
    const response = JSON.parse(event.data);
    const result = resultFromResponse(response);
    this._updateResult(result);
    if (this._onPartialResult != null) {
      this._onPartialResult(result);
    }
  }

  _completeFinishingEarly(dummy) {
    if (this._state != State.FinishingEarly) {
      return;
    }
    this._handleFinished();
  }

  _closeResources() {
    this._closeWebSocket();
    this._closeMedia();
    this._queuedMessages = null;
  }

  _closeWebSocket() {
    if (this._webSocket != null) {
      this._webSocket.onopen = null;
      this._webSocket.onclose = null;
      this._webSocket.onerror = null;
      this._webSocket.onmessage = null;
      this._webSocket.close();
      this._webSocket = null;
    }
  }

  _closeMedia() {
    if (this._mediaRecorder != null) {
      this._mediaRecorder.removeEventListener(
        "data",
        this._mediaRecorderOnData
      );
      this._mediaRecorder.removeEventListener("end", this._mediaRecorderOnEnd);
      this._mediaRecorder.stop();
      this._mediaRecorder.terminateWorker();
      this._mediaRecorderOnData = null;
      this._mediaRecorderOnEnd = null;
      this._mediaRecorder = null;
    }
    if (this._stream != null) {
      this._stopTracks(this._stream);
      this._stream = null;
    }
  }

  _stopTracks(stream) {
    stream.getTracks().forEach(function (track) {
      track.stop();
    });
  }

  _handleError(status, message) {
    this._closeResources();
    this._state = State.Error;
    recordTranscribeActive = false;
    if (this._onError != null) {
      this._onError(status, message);
    }
  }

  _handleFinished() {
    this._closeResources();
    this._state = State.Finished;
    recordTranscribeActive = false;
    if (this._onFinished != null) {
      this._onFinished();
    }
  }

  _updateResult(newResult) {
    const result = this._result;
    const words = result.words;
    while (words.length > 0 && !words[words.length - 1].is_final) {
      words.pop();
    }
    newResult.words.forEach(function (word) {
      words.push(word);
    });
    result.final_proc_time_ms = newResult.final_proc_time_ms;
    result.total_proc_time_ms = newResult.total_proc_time_ms;
    result.speakers = newResult.speakers;
  }
}

RecordTranscribe.notSupported =
  audioRecorderPolyfill.MediaRecorder.notSupported ||
  !navigator.mediaDevices.getUserMedia ||
  !WebSocket;
