/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */
import XlinkController from './controllers/XlinkController.js';
import XlinkLoader from './XlinkLoader.js';
import Error from './vo/Error.js';
import HTTPRequest from './vo/metrics/HTTPRequest.js';
import EventBus from '../core/EventBus.js';
import Events from '../core/events/Events.js';
import FactoryMaker from '../core/FactoryMaker.js';
import Debug from '../core/Debug.js';

function ManifestLoader(config) {

    const RETRY_ATTEMPTS = 5;
    const RETRY_INTERVAL = 500;
    const PARSERERROR_ERROR_CODE = 1;

    let context = this.context;
    let log = Debug(context).getInstance().log;
    let eventBus = EventBus(context).getInstance();

    let parser = config.parser;
    let errHandler = config.errHandler;
    let metricsModel = config.metricsModel;
    let requestModifier = config.requestModifier;

    let instance,
        xlinkController;

    function setup() {
        let xlinkLoader = XlinkLoader(context).create({
            errHandler: errHandler,
            metricsModel: metricsModel,
            requestModifier: requestModifier
        });
        xlinkController = XlinkController(context).create({
            xlinkLoader: xlinkLoader
        });
        eventBus.on(Events.XLINK_READY, onXlinkReady, instance);
    }

    function doLoad(url, remainingAttempts, countingAttempts) {
        var baseUrl = parseBaseUrl(url);

        var request = new XMLHttpRequest();
        var requestTime = new Date();
        var needFailureReport = true;
        var lastTraceTime = requestTime;
        var lastTraceReceivedCount = 0;
        var traces = [];
        var self = this;

        var manifest,
            onload,
            report,
            progress,
            firstProgressCall;

        onload = function () {
            var actualUrl = null;
            var errorMsg;
            var loadedTime = new Date();

            if (request.status < 200 || request.status > 299) {
                return;
            }

            if (request.status == 202) { // Request was accepted, retry later in X seconds, please
                needFailureReport = false;

                var retryAfterInterval = 0;
                var retryAfterIntervals = request.getResponseHeader('Retry-After');
                if (retryAfterIntervals) {
                    retryAfterIntervals = retryAfterIntervals.split(', ');

                    if (retryAfterIntervals.length == 1) {
                        retryAfterInterval = parseInt(retryAfterIntervals[0]) * 1000;
                    } else if (retryAfterIntervals.length == 2) {
                        retryAfterInterval = Date.parse(retryAfterIntervals[0] + ', ' + retryAfterIntervals[1]).getTime() - new Date().getTime();
                    } else if (retryAfterIntervals.length == 3) {
                        if (!isNaN(retryAfterIntervals[2])) {
                            retryAfterInterval = parseInt(retryAfterIntervals[2]) * 1000;
                        } else {
                            retryAfterInterval = parseInt(retryAfterIntervals[0]) * 1000;
                        }
                    }
                }
                if (retryAfterInterval < RETRY_INTERVAL) {
                    retryAfterInterval = RETRY_INTERVAL;
                }

                if (countingAttempts >= RETRY_ATTEMPTS) {
                    log('Maximum attempts reached for manifest: ' + url);
                    needFailureReport = true;
                    remainingAttempts = 0;
                    return;
                }

                log('Postponing loading manifest: ' + url + ', retry in ' + retryAfterInterval + 'ms');
                setTimeout(function () {
                    countingAttempts++;
                    doLoad.call(self, url, remainingAttempts, countingAttempts);
                }, retryAfterInterval);
                return;
            }

            needFailureReport = false;

            // Handle redirects for the MPD - as per RFC3986 Section 5.1.3
            if (request.responseURL && request.responseURL !== url) {
                baseUrl = parseBaseUrl(request.responseURL);
                actualUrl = request.responseURL;
            }

            metricsModel.addHttpRequest('stream',
                null,
                HTTPRequest.MPD_TYPE,
                url,
                actualUrl,
                null,
                requestTime,
                request.firstByteDate || null,
                loadedTime,
                request.status,
                null,
                request.getAllResponseHeaders(),
                traces);

            manifest = parser.parse(request.responseText, baseUrl, xlinkController);

            if (manifest) {
                manifest.url = actualUrl || url;

                // URL from which the MPD was originally retrieved (MPD updates will not change this value)
                if (!manifest.originalUrl) {
                    manifest.originalUrl = manifest.url;
                }

                manifest.loadedTime = loadedTime;
                if (!manifest.availabilityStartTime) {
                    manifest.availabilityStartTime = loadedTime;

                    var availabilityStartTime = request.getResponseHeader('Availability-Start-Time');
                    if (availabilityStartTime) {
                        manifest.availabilityStartTime = new Date(Date.parse(availabilityStartTime));
                    }
                }

                metricsModel.addManifestUpdate('stream', manifest.type, requestTime, loadedTime, manifest.availabilityStartTime);
                xlinkController.resolveManifestOnLoad(manifest);
            } else {
                errorMsg = 'Failed loading manifest: ' + url + ', parsing failed';
                eventBus.trigger(Events.INTERNAL_MANIFEST_LOADED, {manifest: null, error: new Error(PARSERERROR_ERROR_CODE, errorMsg, null)});
                log(errorMsg);
            }
        };

        report = function () {
            if (!needFailureReport) {
                return;
            }
            needFailureReport = false;

            metricsModel.addHttpRequest('stream',
                null,
                HTTPRequest.MPD_TYPE,
                url,
                request.responseURL || null,
                null,
                requestTime,
                request.firstByteDate || null,
                new Date(),
                request.status,
                null,
                request.getAllResponseHeaders(),
                null);

            if (request.status === 415) {
                log('Failed loading manifest: ' + url + ' no attempts have been made because media type is unsupported');
                errHandler.mediaUnsupported('manifest', url, request);
                eventBus.trigger(Events.INTERNAL_MANIFEST_LOADED, {error: new Error('Failed loading manifest: ' + url + ' no attempts have been made because media type is unsupported')});
                return;
            }

            if (remainingAttempts > 0) {
                log('Failed loading manifest: ' + url + ', retry in ' + RETRY_INTERVAL + 'ms' + ' attempts: ' + remainingAttempts);
                remainingAttempts--;
                setTimeout(function () {
                    doLoad.call(self, url, remainingAttempts, countingAttempts);
                }, RETRY_INTERVAL);
            } else {
                log('Failed loading manifest: ' + url + ' no retry attempts left');
                errHandler.downloadError('manifest', url, request);
                eventBus.trigger(Events.INTERNAL_MANIFEST_LOADED, {error: new Error('Failed loading manifest: ' + url + ' no retry attempts left')});
            }
        };

        progress = function (event) {
            var currentTime = new Date();

            if (firstProgressCall) {
                firstProgressCall = false;
                if (!event.lengthComputable || (event.lengthComputable && event.total !== event.loaded)) {
                    request.firstByteDate = currentTime;
                }
            }

            if (event.lengthComputable) {
                request.bytesLoaded = event.loaded;
                request.bytesTotal = event.total;
            }

            traces.push({
                s: lastTraceTime,
                d: currentTime.getTime() - lastTraceTime.getTime(),
                b: [event.loaded ? event.loaded - lastTraceReceivedCount : 0]
            });

            lastTraceTime = currentTime;
            lastTraceReceivedCount = event.loaded;
        };

        try {
            //log("Start loading manifest: " + url);
            request.onload = onload;
            request.onloadend = report;
            request.onerror = report;
            request.onprogress = progress;
            request.open('GET', requestModifier.modifyRequestURL(url), true);
            request = requestModifier.modifyRequestHeader(request);
            request.send();
        } catch (e) {
            request.onerror();
        }
    }

    function load(url) {
        if (!url) {
            eventBus.trigger(Events.INTERNAL_MANIFEST_LOADED, {error: new Error('Failed loading manifest: url is null')});
        } else {
            doLoad(url, RETRY_ATTEMPTS, 0);
        }
    }

    function reset() {
        eventBus.off(Events.XLINK_READY, onXlinkReady, instance);
        requestModifier = null;
        if (xlinkController) {
            xlinkController.reset();
        }
        xlinkController = null;
    }

    function parseBaseUrl(url) {
        var base = '';

        if (url.indexOf('/') !== -1)
        {
            if (url.indexOf('?') !== -1) {
                url = url.substring(0, url.indexOf('?'));
            }
            base = url.substring(0, url.lastIndexOf('/') + 1);
        }

        return base;
    }

    function onXlinkReady(event) {
        eventBus.trigger(Events.INTERNAL_MANIFEST_LOADED, { manifest: event.manifest });
    }

    instance = {
        load: load,
        reset: reset
    };

    setup();
    return instance;
}

ManifestLoader.__dashjs_factory_name = 'ManifestLoader';
export default FactoryMaker.getClassFactory(ManifestLoader);
