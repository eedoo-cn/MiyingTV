(function (window) {
    'use strict';

    function isAbsoluteHttpUrl(url) {
        return typeof url === 'string' && /^https?:\/\//i.test(url);
    }

    function toText(value) {
        return (value || '').trim();
    }

    function toNumber(value, fallback = 0) {
        const num = Number(value);
        return Number.isFinite(num) ? num : fallback;
    }

    function deepMerge(base, extra) {
        if (!extra || typeof extra !== 'object') {
            return Array.isArray(base) ? [...base] : { ...base };
        }

        const seed = Array.isArray(base) ? [...base] : { ...base };
        Object.keys(extra).forEach((key) => {
            const extraValue = extra[key];
            const baseValue = seed[key];
            if (Array.isArray(extraValue)) {
                seed[key] = [...extraValue];
                return;
            }
            if (extraValue && typeof extraValue === 'object') {
                seed[key] = deepMerge(baseValue && typeof baseValue === 'object' ? baseValue : {}, extraValue);
                return;
            }
            seed[key] = extraValue;
        });
        return seed;
    }

    class DPlayerAdController {
        constructor(options = {}) {
            this.player = options.player || null;
            this.playerRoot = options.playerRoot || (this.player && this.player.container) || null;
            this.wrapper = options.wrapper || (this.playerRoot && this.playerRoot.parentElement) || null;
            this.config = this.mergeConfig(options.config || {});
            this.slotContext = options.slotContext || {};
            this.state = this.createEmptyState();
            this.overlay = null;
            this.elements = {};
            this.boundEvents = [];
            this.playPromise = null;
            this.currentResolve = null;
            this.currentReject = null;
            this.adHls = null;
            this.ensureOverlay();
        }

        mergeConfig(runtimeConfig) {
            const defaults = {
                enabled: false,
                debug: false,
                requestTimeout: 8000,
                wrapperMaxDepth: 5,
                skipAfter: 5,
                seekGuardTolerance: 0.35,
                useProxyForVast: true,
                useProxyForMedia: false,
                trackingEnabled: true,
                slots: {
                    preroll: {
                        enabled: true,
                        tagUrls: [],
                        frequency: {
                            storageKey: 'miying_dplayer_ad_frequency',
                            capId: 'preroll',
                            maxImpressions: 2,
                            windowMs: 60 * 60 * 1000
                        }
                    }
                }
            };
            return deepMerge(defaults, runtimeConfig);
        }

        createEmptyState() {
            return {
                isPlaying: false,
                slotName: '',
                ad: null,
                currentTime: 0,
                maxWatchedTime: 0,
                skipAfter: 0,
                hasStarted: false,
                skipUnlocked: false,
                quartilesFired: new Set(),
                trackingSent: new Set(),
                clickSent: false,
                impressionSent: false
            };
        }

        log(...args) {
            if (this.config.debug) {
                console.log('[DPlayerAds]', ...args);
            }
        }

        isEnabled() {
            return !!this.config.enabled;
        }

        isAdPlaying() {
            return !!this.state.isPlaying;
        }

        isSlotEnabled(slotName) {
            const slot = this.getSlotConfig(slotName);
            return this.isEnabled() && !!slot.enabled && Array.isArray(slot.tagUrls) && slot.tagUrls.length > 0;
        }

        getSlotConfig(slotName) {
            const slots = this.config.slots || {};
            return slots[slotName] || {};
        }

        ensureOverlay() {
            if (!this.wrapper) {
                return;
            }

            let overlay = this.wrapper.querySelector('.vast-ad-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.className = 'vast-ad-overlay';
                overlay.setAttribute('aria-hidden', 'true');
                overlay.innerHTML = `
                    <video class="vast-ad-video" playsinline preload="auto" webkit-playsinline></video>
                    <button type="button" class="vast-ad-click-layer" aria-label="打开广告"></button>
                    <div class="vast-ad-header">
                        <span class="vast-ad-badge">广告</span>
                        <span class="vast-ad-title">广告加载中</span>
                    </div>
                    <div class="vast-ad-footer">
                        <span class="vast-ad-countdown">广告即将开始</span>
                        <button type="button" class="vast-ad-cta">查看详情</button>
                        <button type="button" class="vast-ad-skip" disabled>5 秒后可跳过</button>
                    </div>
                `;
                this.wrapper.appendChild(overlay);
            }

            this.overlay = overlay;
            this.elements.video = overlay.querySelector('.vast-ad-video');
            this.elements.clickLayer = overlay.querySelector('.vast-ad-click-layer');
            this.elements.title = overlay.querySelector('.vast-ad-title');
            this.elements.countdown = overlay.querySelector('.vast-ad-countdown');
            this.elements.skipButton = overlay.querySelector('.vast-ad-skip');
            this.elements.ctaButton = overlay.querySelector('.vast-ad-cta');
        }

        destroy() {
            this.finishAd('destroyed', false, true);
            this.removeAllBoundEvents();

            if (this.overlay) {
                this.overlay.classList.remove('is-active');
                this.overlay.setAttribute('aria-hidden', 'true');
            }
        }

        async playSlot(slotName) {
            if (!this.isSlotEnabled(slotName)) {
                return { played: false, reason: 'disabled' };
            }

            const slotConfig = this.getSlotConfig(slotName);
            if (!this.canPlaySlot(slotName, slotConfig)) {
                this.log('frequency capped', slotName);
                return { played: false, reason: 'frequency-capped' };
            }

            const tagUrls = slotConfig.tagUrls.filter(Boolean);
            for (let i = 0; i < tagUrls.length; i += 1) {
                const tagUrl = tagUrls[i];
                try {
                    const resolvedAd = await this.resolveVastAd(tagUrl);
                    if (!resolvedAd || !resolvedAd.mediaFile || !resolvedAd.mediaFile.url) {
                        continue;
                    }
                    await this.playResolvedAd(resolvedAd, slotName, slotConfig);
                    return { played: true, reason: 'completed', ad: resolvedAd };
                } catch (error) {
                    this.log('ad tag failed', tagUrl, error);
                }
            }

            return { played: false, reason: 'no-fill' };
        }

        async resolveVastAd(tagUrl, depth = 0, inherited = null) {
            if (depth > this.config.wrapperMaxDepth) {
                throw new Error('VAST wrapper depth exceeded');
            }

            const xmlText = await this.fetchVastText(tagUrl);
            const doc = this.parseXml(xmlText);
            const adNodes = Array.from(doc.querySelectorAll('Ad'));
            if (!adNodes.length) {
                throw new Error('No VAST ad found');
            }

            for (const adNode of adNodes) {
                const inlineNode = adNode.querySelector('Inline');
                const wrapperNode = adNode.querySelector('Wrapper');
                if (wrapperNode) {
                    const wrapperPayload = this.parseAdNode(wrapperNode, adNode);
                    const wrappedUrl = this.readNodeText(wrapperNode, 'VASTAdTagURI');
                    if (!wrappedUrl) {
                        continue;
                    }
                    const mergedWrapper = this.mergeAdPayload(inherited, wrapperPayload);
                    return this.resolveVastAd(wrappedUrl, depth + 1, mergedWrapper);
                }
                if (inlineNode) {
                    const inlinePayload = this.parseAdNode(inlineNode, adNode);
                    return this.mergeAdPayload(inherited, inlinePayload);
                }
            }

            throw new Error('No inline or wrapper ad found');
        }

        parseAdNode(node, adNode) {
            const title = this.readNodeText(node, 'AdTitle') || this.readNodeText(node, 'Title') || '品牌广告';
            const adId = adNode ? (adNode.getAttribute('id') || adNode.getAttribute('sequence') || '') : '';
            const impressionUrls = this.readNodeTexts(node, 'Impression');
            const errorUrls = this.readNodeTexts(node, 'Error');
            const linear = node.querySelector('Creatives Creative Linear');
            const mediaFiles = linear ? Array.from(linear.querySelectorAll('MediaFiles MediaFile')).map((mediaNode) => ({
                url: toText(mediaNode.textContent),
                type: mediaNode.getAttribute('type') || '',
                width: toNumber(mediaNode.getAttribute('width')),
                height: toNumber(mediaNode.getAttribute('height')),
                bitrate: toNumber(mediaNode.getAttribute('bitrate')),
                delivery: mediaNode.getAttribute('delivery') || '',
                scalable: mediaNode.getAttribute('scalable') === 'true'
            })).filter((item) => item.url) : [];
            const trackingEvents = linear ? Array.from(linear.querySelectorAll('TrackingEvents Tracking')).reduce((acc, trackingNode) => {
                const eventName = trackingNode.getAttribute('event');
                const trackingUrl = toText(trackingNode.textContent);
                if (!eventName || !trackingUrl) {
                    return acc;
                }
                if (!acc[eventName]) {
                    acc[eventName] = [];
                }
                acc[eventName].push(trackingUrl);
                return acc;
            }, {}) : {};
            const clickThrough = linear ? this.readNodeText(linear, 'VideoClicks ClickThrough') : '';
            const clickTrackers = linear ? this.readNodeTexts(linear, 'VideoClicks ClickTracking') : [];
            const duration = linear ? this.parseDuration(this.readNodeText(linear, 'Duration')) : 0;
            const skipOffsetRaw = linear ? linear.getAttribute('skipoffset') : '';
            const skipOffset = this.parseSkipOffset(skipOffsetRaw, duration);

            return {
                adId,
                title,
                duration,
                skipOffset,
                impressionUrls,
                errorUrls,
                trackingEvents,
                clickThrough,
                clickTrackers,
                mediaFiles,
                mediaFile: this.pickBestMediaFile(mediaFiles)
            };
        }

        mergeAdPayload(base, extra) {
            if (!base) {
                return {
                    ...extra,
                    impressionUrls: [...(extra.impressionUrls || [])],
                    errorUrls: [...(extra.errorUrls || [])],
                    clickTrackers: [...(extra.clickTrackers || [])],
                    trackingEvents: this.cloneTrackingMap(extra.trackingEvents || {}),
                    mediaFiles: [...(extra.mediaFiles || [])]
                };
            }

            const merged = {
                ...base,
                ...extra,
                title: extra.title || base.title,
                adId: extra.adId || base.adId,
                duration: extra.duration || base.duration,
                skipOffset: Math.max(toNumber(base.skipOffset), toNumber(extra.skipOffset)),
                impressionUrls: [...(base.impressionUrls || []), ...(extra.impressionUrls || [])],
                errorUrls: [...(base.errorUrls || []), ...(extra.errorUrls || [])],
                clickTrackers: [...(base.clickTrackers || []), ...(extra.clickTrackers || [])],
                trackingEvents: this.mergeTrackingMaps(base.trackingEvents || {}, extra.trackingEvents || {}),
                mediaFiles: (extra.mediaFiles && extra.mediaFiles.length) ? extra.mediaFiles : (base.mediaFiles || []),
                mediaFile: extra.mediaFile || base.mediaFile,
                clickThrough: extra.clickThrough || base.clickThrough
            };

            if (!merged.mediaFile && merged.mediaFiles.length) {
                merged.mediaFile = this.pickBestMediaFile(merged.mediaFiles);
            }

            return merged;
        }

        cloneTrackingMap(map) {
            const cloned = {};
            Object.keys(map).forEach((key) => {
                cloned[key] = [...map[key]];
            });
            return cloned;
        }

        mergeTrackingMaps(base, extra) {
            const merged = this.cloneTrackingMap(base);
            Object.keys(extra).forEach((key) => {
                merged[key] = [...(merged[key] || []), ...(extra[key] || [])];
            });
            return merged;
        }

        pickBestMediaFile(mediaFiles) {
            if (!Array.isArray(mediaFiles) || !mediaFiles.length) {
                return null;
            }

            const scored = mediaFiles.map((mediaFile) => {
                const type = (mediaFile.type || '').toLowerCase();
                let score = 0;
                if (type.includes('mp4')) score += 30;
                if (type.includes('webm')) score += 20;
                if (type.includes('mpegurl') || mediaFile.url.endsWith('.m3u8')) score += 10;
                if ((mediaFile.delivery || '').toLowerCase() === 'progressive') score += 10;
                if (mediaFile.width && mediaFile.height) score += Math.min(mediaFile.width * mediaFile.height, 1920 * 1080) / 100000;
                score -= Math.abs((mediaFile.bitrate || 0) - 1200) / 500;
                return { mediaFile, score };
            });

            scored.sort((a, b) => b.score - a.score);
            return scored[0].mediaFile;
        }

        parseDuration(value) {
            const parts = String(value || '').split(':').map((part) => Number(part));
            if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) {
                return 0;
            }
            return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
        }

        parseSkipOffset(value, duration) {
            if (!value) {
                return 0;
            }
            if (String(value).includes('%')) {
                const percent = parseFloat(value);
                if (!Number.isNaN(percent) && duration > 0) {
                    return Math.floor((duration * percent) / 100);
                }
                return 0;
            }
            return this.parseDuration(value);
        }

        async fetchVastText(tagUrl) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.config.requestTimeout);
            const requestUrl = this.buildVastRequestUrl(tagUrl);

            try {
                const response = await fetch(requestUrl, {
                    method: 'GET',
                    credentials: 'omit',
                    signal: controller.signal
                });
                if (!response.ok) {
                    throw new Error(`VAST request failed: ${response.status}`);
                }
                return response.text();
            } finally {
                clearTimeout(timeout);
            }
        }

        buildVastRequestUrl(url) {
            if (!isAbsoluteHttpUrl(url)) {
                return url;
            }
            if (!this.config.useProxyForVast) {
                return url;
            }
            const proxyBase = window.PROXY_URL || '/proxy/';
            return `${proxyBase}${encodeURIComponent(url)}`;
        }

        buildMediaUrl(url) {
            if (!isAbsoluteHttpUrl(url) || !this.config.useProxyForMedia) {
                return url;
            }
            const proxyBase = window.PROXY_URL || '/proxy/';
            return `${proxyBase}${encodeURIComponent(url)}`;
        }

        parseXml(xmlText) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlText, 'application/xml');
            const parseError = doc.querySelector('parsererror');
            if (parseError) {
                throw new Error('Invalid VAST XML');
            }
            return doc;
        }

        readNodeText(root, selector) {
            const node = root.querySelector(selector);
            return node ? toText(node.textContent) : '';
        }

        readNodeTexts(root, selector) {
            return Array.from(root.querySelectorAll(selector))
                .map((node) => toText(node.textContent))
                .filter(Boolean);
        }

        canPlaySlot(slotName, slotConfig) {
            const frequency = (slotConfig && slotConfig.frequency) || {};
            const storageKey = frequency.storageKey;
            const windowMs = toNumber(frequency.windowMs, 0);
            const maxImpressions = toNumber(frequency.maxImpressions, 0);
            if (!storageKey || !windowMs || !maxImpressions) {
                return true;
            }

            const capId = frequency.capId || slotName;
            const allRecords = this.readFrequencyStore(storageKey);
            const now = Date.now();
            const records = (allRecords[capId] || []).filter((ts) => (now - ts) < windowMs);
            allRecords[capId] = records;
            this.writeFrequencyStore(storageKey, allRecords);
            return records.length < maxImpressions;
        }

        markSlotPlayed(slotName, slotConfig) {
            const frequency = (slotConfig && slotConfig.frequency) || {};
            const storageKey = frequency.storageKey;
            const windowMs = toNumber(frequency.windowMs, 0);
            if (!storageKey || !windowMs) {
                return;
            }

            const capId = frequency.capId || slotName;
            const allRecords = this.readFrequencyStore(storageKey);
            const now = Date.now();
            const records = (allRecords[capId] || []).filter((ts) => (now - ts) < windowMs);
            records.push(now);
            allRecords[capId] = records;
            this.writeFrequencyStore(storageKey, allRecords);
        }

        readFrequencyStore(storageKey) {
            try {
                return JSON.parse(localStorage.getItem(storageKey) || '{}');
            } catch (error) {
                return {};
            }
        }

        writeFrequencyStore(storageKey, value) {
            try {
                localStorage.setItem(storageKey, JSON.stringify(value));
            } catch (error) {
                this.log('write frequency store failed', error);
            }
        }

        async playResolvedAd(ad, slotName, slotConfig) {
            if (!this.elements.video) {
                throw new Error('ad overlay missing');
            }

            this.removeAllBoundEvents();
            this.state = this.createEmptyState();
            this.state.isPlaying = true;
            this.state.slotName = slotName;
            this.state.ad = ad;

            this.showOverlay(ad);
            this.pauseContent();

            const adVideo = this.elements.video;
            const skipAfter = Math.max(toNumber(this.config.skipAfter, 5), toNumber(ad.skipOffset, 0), 0);
            this.state.skipAfter = skipAfter;
            const mediaUrl = this.buildMediaUrl(ad.mediaFile.url);

            adVideo.muted = false;
            adVideo.playsInline = true;
            adVideo.preload = 'auto';

            this.playPromise = new Promise((resolve, reject) => {
                this.currentResolve = resolve;
                this.currentReject = reject;

                this.bind(adVideo, 'play', () => {
                    if (!this.state.hasStarted) {
                        this.state.hasStarted = true;
                        this.markSlotPlayed(slotName, slotConfig);
                        this.fireImpression(ad);
                        this.fireTrackingEvent('start');
                    }
                });

                this.bind(adVideo, 'loadedmetadata', () => {
                    this.updateCountdown();
                });

                this.bind(adVideo, 'timeupdate', () => {
                    this.state.currentTime = adVideo.currentTime || 0;
                    this.state.maxWatchedTime = Math.max(this.state.maxWatchedTime, this.state.currentTime);
                    this.updateSkipState(skipAfter);
                    this.updateCountdown();
                    this.trackQuartiles();
                });

                this.bind(adVideo, 'seeking', () => {
                    if (!this.state.isPlaying) {
                        return;
                    }
                    if ((adVideo.currentTime - this.state.maxWatchedTime) > this.config.seekGuardTolerance) {
                        adVideo.currentTime = this.state.maxWatchedTime;
                    }
                });

                this.bind(adVideo, 'ended', () => {
                    this.fireTrackingEvent('complete');
                    this.finishAd('completed');
                });

                this.bind(adVideo, 'error', () => {
                    this.fireTrackingEvent('error', '405');
                    if (!this.state.hasStarted) {
                        this.finishAd('media-error', true);
                        return;
                    }
                    this.finishAd('media-error');
                });
            });

            this.elements.skipButton.disabled = true;
            this.elements.skipButton.textContent = `${skipAfter} 秒后可跳过`;
            this.elements.skipButton.onclick = () => {
                if (!this.state.skipUnlocked) {
                    return;
                }
                this.fireTrackingEvent('skip');
                this.finishAd('skipped');
            };

            const handleClick = () => {
                if (!ad.clickThrough) {
                    return;
                }
                this.fireClickTracking(ad);
                window.open(ad.clickThrough, '_blank', 'noopener');
            };
            this.elements.clickLayer.onclick = handleClick;
            this.elements.ctaButton.onclick = handleClick;
            this.elements.ctaButton.style.display = ad.clickThrough ? 'inline-flex' : 'none';

            try {
                await this.prepareAdMedia(adVideo, mediaUrl, ad.mediaFile);
                await adVideo.play();
            } catch (error) {
                this.log('ad autoplay or media setup failed', error);
                this.finishAd('autoplay-blocked', true);
            }

            return this.playPromise;
        }

        async prepareAdMedia(adVideo, mediaUrl, mediaFile) {
            this.destroyAdHls();

            const mediaType = (mediaFile && mediaFile.type ? mediaFile.type : '').toLowerCase();
            const isHlsAd = mediaType.includes('mpegurl') || /\.m3u8($|\?)/i.test(mediaUrl);

            adVideo.currentTime = 0;

            if (isHlsAd && window.Hls && window.Hls.isSupported && window.Hls.isSupported()) {
                await new Promise((resolve, reject) => {
                    const hls = new window.Hls({
                        debug: false,
                        enableWorker: true,
                        lowLatencyMode: false
                    });
                    this.adHls = hls;

                    const cleanup = () => {
                        hls.off(window.Hls.Events.MANIFEST_PARSED, onParsed);
                        hls.off(window.Hls.Events.ERROR, onError);
                    };
                    const onParsed = () => {
                        cleanup();
                        resolve();
                    };
                    const onError = (event, data) => {
                        if (!data || !data.fatal) {
                            return;
                        }
                        cleanup();
                        reject(new Error(`Ad HLS error: ${data.type || 'unknown'}`));
                    };

                    hls.on(window.Hls.Events.MANIFEST_PARSED, onParsed);
                    hls.on(window.Hls.Events.ERROR, onError);
                    hls.loadSource(mediaUrl);
                    hls.attachMedia(adVideo);
                });
                return;
            }

            adVideo.src = mediaUrl;
            adVideo.load();
        }

        showOverlay(ad) {
            if (!this.overlay || !this.player || !this.player.container) {
                return;
            }

            this.elements.title.textContent = ad.title || '品牌广告';
            this.elements.countdown.textContent = '广告准备播放';
            this.overlay.classList.add('is-active');
            this.overlay.setAttribute('aria-hidden', 'false');
            this.player.container.classList.add('ad-break-active');
            document.body.classList.add('ad-break-active');
        }

        updateSkipState(skipAfter) {
            if (this.state.skipUnlocked || this.state.currentTime < skipAfter) {
                return;
            }
            this.state.skipUnlocked = true;
            this.elements.skipButton.disabled = false;
            this.elements.skipButton.textContent = '跳过广告';
        }

        updateCountdown() {
            const ad = this.state.ad;
            const adVideo = this.elements.video;
            if (!ad || !adVideo) {
                return;
            }

            const duration = adVideo.duration || ad.duration || 0;
            const currentTime = adVideo.currentTime || 0;
            const remain = duration > 0 ? Math.max(0, Math.ceil(duration - currentTime)) : 0;
            this.elements.countdown.textContent = remain > 0
                ? `广告剩余 ${remain} 秒`
                : '广告播放中';

            if (!this.state.skipUnlocked) {
                const wait = Math.max(0, Math.ceil(this.state.skipAfter - currentTime));
                this.elements.skipButton.textContent = wait > 0 ? `${wait} 秒后可跳过` : '跳过广告';
            }
        }

        trackQuartiles() {
            const adVideo = this.elements.video;
            if (!adVideo || !adVideo.duration || !this.state.hasStarted) {
                return;
            }

            const progress = adVideo.currentTime / adVideo.duration;
            const marks = [
                { key: 'firstQuartile', ratio: 0.25 },
                { key: 'midpoint', ratio: 0.5 },
                { key: 'thirdQuartile', ratio: 0.75 }
            ];

            marks.forEach((mark) => {
                if (progress >= mark.ratio && !this.state.quartilesFired.has(mark.key)) {
                    this.state.quartilesFired.add(mark.key);
                    this.fireTrackingEvent(mark.key);
                }
            });
        }

        fireImpression(ad) {
            if (this.state.impressionSent) {
                return;
            }
            this.state.impressionSent = true;
            this.pingAll(ad.impressionUrls || []);
        }

        fireClickTracking(ad) {
            if (this.state.clickSent) {
                return;
            }
            this.state.clickSent = true;
            this.pingAll(ad.clickTrackers || []);
        }

        fireTrackingEvent(eventName, errorCode) {
            if (!this.config.trackingEnabled || !this.state.ad) {
                return;
            }

            const key = `${eventName}:${errorCode || ''}`;
            if (this.state.trackingSent.has(key) && eventName !== 'error') {
                return;
            }
            this.state.trackingSent.add(key);

            const urls = (this.state.ad.trackingEvents && this.state.ad.trackingEvents[eventName]) || [];
            if (eventName === 'error' && this.state.ad.errorUrls) {
                this.pingAll(this.state.ad.errorUrls, errorCode || '900');
            }
            this.pingAll(urls, errorCode);
        }

        pingAll(urls, errorCode) {
            urls.filter(Boolean).forEach((url) => {
                const finalUrl = this.replaceMacros(url, errorCode);
                try {
                    const beacon = new Image();
                    beacon.referrerPolicy = 'no-referrer';
                    beacon.src = finalUrl;
                } catch (error) {
                    this.log('tracking ping failed', finalUrl, error);
                }
            });
        }

        replaceMacros(url, errorCode) {
            const cacheBuster = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
            return String(url)
                .replace(/\[ERRORCODE\]/gi, errorCode || '900')
                .replace(/\[CACHEBUSTING\]/gi, cacheBuster)
                .replace(/\[TIMESTAMP\]/gi, cacheBuster);
        }

        pauseContent() {
            if (!this.player || !this.player.video) {
                return;
            }
            try {
                this.player.video.pause();
            } catch (error) {
                this.log('pause content failed', error);
            }
        }

        finishAd(reason, rejectPlayback = false, silent = false) {
            this.destroyAdHls();

            if (this.elements.video) {
                try {
                    this.elements.video.pause();
                    this.elements.video.removeAttribute('src');
                    this.elements.video.load();
                } catch (error) {
                    this.log('reset ad video failed', error);
                }
            }

            this.removeAllBoundEvents();

            if (this.overlay) {
                this.overlay.classList.remove('is-active');
                this.overlay.setAttribute('aria-hidden', 'true');
            }
            if (this.player && this.player.container) {
                this.player.container.classList.remove('ad-break-active');
            }
            document.body.classList.remove('ad-break-active');

            const resolve = this.currentResolve;
            const reject = this.currentReject;

            this.currentResolve = null;
            this.currentReject = null;
            this.playPromise = null;

            const hadStarted = this.state.hasStarted;
            this.state = this.createEmptyState();

            if (silent) {
                return;
            }

            if (rejectPlayback && typeof reject === 'function') {
                reject(new Error(reason || 'ad failed'));
                return;
            }

            if (typeof resolve === 'function') {
                resolve({ reason, started: hadStarted });
            }
        }

        destroyAdHls() {
            if (this.adHls && typeof this.adHls.destroy === 'function') {
                try {
                    this.adHls.destroy();
                } catch (error) {
                    this.log('destroy ad hls failed', error);
                }
            }
            this.adHls = null;
        }

        bind(target, eventName, handler, options) {
            if (!target) {
                return;
            }
            target.addEventListener(eventName, handler, options);
            this.boundEvents.push({ target, eventName, handler, options });
        }

        removeAllBoundEvents() {
            this.boundEvents.forEach(({ target, eventName, handler, options }) => {
                target.removeEventListener(eventName, handler, options);
            });
            this.boundEvents = [];
        }
    }

    window.DPlayerAdController = DPlayerAdController;
})(window);
