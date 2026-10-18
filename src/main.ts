import { App, FileView, ItemView, MarkdownView, Platform, Plugin, setIcon, WorkspaceLeaf } from "obsidian";

// -- Types -------------------------------------------------------------------

type Evt = "play" | "pause" | "timeupdate" | "ratechange";
type Cb = () => void;

// -- Controller --------------------------------------------------------------
// Maintains a pool of <audio> elements, one per note, so each note keeps its
// loaded audio and position. Only the active one plays, and it keeps playing
// while you move to other pages.

class Controller {
	/** notePath -> audio element (keeps loaded state, position, etc.). */
	private pool = new Map<string, HTMLAudioElement>();
	/** src -> position it was left at, for a note with several audio embeds. */
	private positions = new Map<string, number>();
	private activeNote = "";
	private volume = 1;
	private rate = 1;
	private subs = new Map<Evt, Set<Cb>>();

	/** Get the audio element for a note. */
	private getEl(note: string): HTMLAudioElement | null {
		return this.pool.get(note) ?? null;
	}

	/** The currently active audio element. */
	get active(): HTMLAudioElement | null {
		return this.getEl(this.activeNote);
	}

	get hasActive(): boolean { return this.active !== null; }
	get notePath(): string { return this.activeNote; }
	get playing(): boolean { return this.active ? !this.active.paused && !this.active.ended : false; }
	get currentTime(): number { return this.active?.currentTime ?? 0; }
	get playbackRate(): number { return this.rate; }

	duration(): number { return this.active?.duration ?? 0; }

	/**
	 * Start playing a src in a note. Creates or reuses an audio element.
	 * `from` is where the embed's scrubber sits: it mirrors the playback
	 * position, so it only differs when the user dragged it.
	 */
	loadAndPlay(src: string, note: string, from = 0) {
		this.active?.pause();

		let el = this.pool.get(note);
		if (!el) {
			el = document.body.createEl("audio", { cls: "pp-pooled" });
			this.pool.set(note, el);
			this.wireEvents(el);
		}

		if (el.src !== src) {
			// Switching to another audio in the same note: remember where the
			// outgoing one was, and resume the incoming one where it was left.
			if (el.src) this.positions.set(el.src, el.currentTime);
			el.src = src;
			const audio = el;
			const resumeAt = from || this.positions.get(src);
			if (resumeAt) audio.addEventListener("loadedmetadata", () => { audio.currentTime = resumeAt; }, { once: true });
		} else if (Math.abs(from - el.currentTime) > 1) {
			el.currentTime = from;
		}
		el.volume = this.volume;
		el.playbackRate = this.rate;
		this.activeNote = note;
		void el.play();
	}

	/** Where src was left in a note: live if it's loaded there, else remembered. */
	positionOf(src: string, note: string): number {
		const el = this.pool.get(note);
		if (el && el.src === src) return el.currentTime;
		return this.positions.get(src) ?? 0;
	}

	play() { void this.active?.play(); }
	pause() { this.active?.pause(); }
	toggle() { if (this.playing) this.pause(); else this.play(); }
	seek(t: number) { if (this.active) this.active.currentTime = t; }

	/** Jump relative to the current position, clamped to [0, duration]. */
	seekBy(delta: number) {
		const el = this.active;
		if (!el) return;
		const d = this.duration();
		let t = el.currentTime + delta;
		if (t < 0) t = 0;
		if (d && t > d) t = d;
		el.currentTime = t;
		this.emit("timeupdate");
	}

	setRate(r: number) {
		this.rate = r;
		if (this.active) this.active.playbackRate = r;
		this.emit("ratechange");
	}

	/** Remove a note's audio from the pool (close button). */
	clearNote(note: string) {
		const el = this.pool.get(note);
		if (el) { el.pause(); el.remove(); this.pool.delete(note); }
		if (this.activeNote === note) this.activeNote = "";
	}

	/** Follow a note that was renamed or moved. */
	renameNote(oldPath: string, newPath: string) {
		const el = this.pool.get(oldPath);
		if (!el) return;
		this.pool.delete(oldPath);
		this.pool.set(newPath, el);
		if (this.activeNote === oldPath) this.activeNote = newPath;
	}

	private wireEvents(el: HTMLAudioElement) {
		el.addEventListener("play", () => { if (el === this.active) this.emit("play"); });
		el.addEventListener("pause", () => { if (el === this.active) this.emit("pause"); });
		el.addEventListener("timeupdate", () => { if (el === this.active) this.emit("timeupdate"); });
		el.addEventListener("ended", () => {
			if (el === this.active) {
				el.currentTime = 0;
				this.emit("pause");
			}
		});
		el.addEventListener("ratechange", () => { if (el === this.active) this.emit("ratechange"); });
	}

	on(ev: Evt, cb: Cb) {
		let set = this.subs.get(ev);
		if (!set) { set = new Set(); this.subs.set(ev, set); }
		set.add(cb);
	}

	private emit(ev: Evt) {
		this.subs.get(ev)?.forEach(cb => cb());
	}

	destroy() {
		for (const el of this.pool.values()) { el.pause(); el.remove(); }
		this.pool.clear();
		this.subs.clear();
	}
}

// -- Now Playing Bar ---------------------------------------------------------

class NowPlayingBar {
	private bar: HTMLElement | null = null;
	private playBtn: HTMLElement | null = null;
	private track: HTMLElement | null = null;
	private fill: HTMLElement | null = null;
	private timeEl: HTMLElement | null = null;
	private rateEl: HTMLElement | null = null;
	private sourceEl: HTMLElement | null = null;
	private dragging = false;
	private measureQueued = false;

	constructor(private ctrl: Controller, private app: App, plugin: Plugin) {
		ctrl.on("play", () => { this.show(); this.syncIcon(); });
		ctrl.on("pause", () => this.syncIcon());
		ctrl.on("timeupdate", () => this.syncProgress());
		ctrl.on("ratechange", () => { if (this.rateEl) this.rateEl.textContent = `${this.ctrl.playbackRate}x`; });

		// The audio keeps playing from page to page, so the bar follows along.
		plugin.registerEvent(app.workspace.on("active-leaf-change", () => this.attach()));
		plugin.registerEvent(app.workspace.on("layout-change", () => this.attach()));

		// Resizing the window, a split or a sidebar can move the bar under the status bar.
		plugin.registerEvent(app.workspace.on("resize", () => this.requestMeasure()));

		// Toggling a theme's focus mode or full screen flips body classes and can
		// show or hide the status bar. Obsidian's addClass/removeClass rewrite the
		// attribute even when nothing changes, so only react to a real change.
		let classes = document.body.className;
		const observer = new MutationObserver(() => {
			if (document.body.className === classes) return;
			classes = document.body.className;
			this.requestMeasure();
		});
		observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
		plugin.register(() => observer.disconnect());
		// A status bar fading in or out has only settled once its transition ends.
		plugin.registerDomEvent(document, "transitionend", (e) => {
			if (e.target instanceof HTMLElement && e.target.hasClass("status-bar")) this.requestMeasure();
		});
	}

	show() {
		if (!this.bar) this.build();
		this.attach();
	}

	private build() {
		const bar = (this.bar = createDiv("pp-now-playing"));

		this.mkSkip(bar, "-5s", "Skip back 5 seconds", -5);
		const play = (this.playBtn = bar.createDiv("clickable-icon pp-np-play"));
		setIcon(play, this.ctrl.playing ? "pause" : "play");
		play.setAttribute("aria-label", "Play or pause");
		play.setAttribute("title", "Play or pause");
		play.addEventListener("click", () => this.ctrl.toggle());
		this.mkSkip(bar, "+5s", "Skip forward 5 seconds", 5);

		this.sourceEl = bar.createDiv("pp-np-source");
		this.sourceEl.addEventListener("click", () => {
			const file = this.app.vault.getFileByPath(this.ctrl.notePath);
			if (file) void this.app.workspace.getLeaf(false).openFile(file);
		});

		const center = bar.createDiv("pp-np-center");
		this.track = center.createDiv("pp-np-track");
		this.fill = this.track.createDiv("pp-np-fill");
		this.syncProgress();
		// Pointer events cover mouse, touch and pen; capture keeps the drag
		// going when the finger or cursor leaves the track.
		center.addEventListener("pointerdown", (e) => {
			this.dragging = true;
			center.setPointerCapture(e.pointerId);
			this.seekTo(e.clientX);
		});
		center.addEventListener("pointermove", (e) => { if (this.dragging) this.seekTo(e.clientX); });
		const endDrag = () => { this.dragging = false; };
		center.addEventListener("pointerup", endDrag);
		center.addEventListener("pointercancel", endDrag);

		const right = bar.createDiv("pp-np-right");
		this.timeEl = right.createSpan({ cls: "pp-np-time" });
		this.syncProgress();
		this.rateEl = right.createDiv("clickable-icon pp-np-rate");
		this.rateEl.textContent = `${this.ctrl.playbackRate}x`;
		this.rateEl.setAttribute("aria-label", "Playback speed");
		this.rateEl.setAttribute("title", "Playback speed");
		this.rateEl.addEventListener("click", () => this.cycleRate());
		const close = right.createDiv("clickable-icon pp-np-close");
		setIcon(close, "x");
		close.setAttribute("aria-label", "Close player");
		close.setAttribute("title", "Close player");
		close.addEventListener("click", () => {
			this.ctrl.clearNote(this.ctrl.notePath);
			this.hide();
		});
	}

	/** Move the bar to the bottom of the main-area page you're on, whatever kind of page it is. */
	attach() {
		const bar = this.bar;
		const leaf = this.app.workspace.getMostRecentLeaf();
		if (!bar || !leaf || !(leaf.view instanceof ItemView)) return;

		// After .view-content, not inside it: the editor fills .view-content,
		// which clips anything below. The leaf is a flex column, so the content
		// shrinks to make room for the bar.
		const vc = leaf.view.contentEl;
		if (bar.previousElementSibling !== vc) vc.after(bar);
		this.syncSource(leaf);
		this.requestMeasure();
	}

	/** Away from the audio's note, name it in the bar; clicking the name goes back. */
	private syncSource(leaf: WorkspaceLeaf) {
		const el = this.sourceEl;
		if (!el) return;
		const file = this.app.vault.getFileByPath(this.ctrl.notePath);
		const here = leaf.view instanceof FileView && leaf.view.file === file;
		el.toggle(!!file && !here);
		if (!file) return;
		el.setText(file.basename);
		el.setAttribute("aria-label", `Go to ${file.basename}`);
		el.setAttribute("title", `Go to ${file.basename}`);
	}

	/**
	 * Measure on the next frame, at most once per frame. Measuring writes to
	 * the DOM, so this keeps any feedback through the observers from spinning.
	 */
	private requestMeasure() {
		if (this.measureQueued) return;
		this.measureQueued = true;
		window.requestAnimationFrame(() => {
			this.measureQueued = false;
			this.clearBottomObstructions();
		});
	}

	/**
	 * On desktop the status bar floats over the bottom corner of the workspace
	 * and can cover the bar's controls. Pad the bar up until they clear it.
	 * Phones reserve room for the floating navbar in CSS instead.
	 */
	private clearBottomObstructions() {
		const bar = this.bar;
		if (!bar || Platform.isMobile) return;

		bar.setCssProps({ "--pp-bottom-offset": "0px" });
		const r = bar.getBoundingClientRect();
		let offset = 0;
		let hiddenOnTop = false;

		const status = document.body.querySelector(".status-bar");
		if (status) {
			const s = status.getBoundingClientRect();
			// Only an overlapping status bar matters; one over another pane is fine.
			if (s.height > 0 && s.left < r.right && s.right > r.left && s.top < r.bottom) {
				// A theme can fade it out yet leave it on top (Minimal's focus
				// mode): then skip the padding and let clicks through to the bar.
				if (getComputedStyle(status).opacity === "0") hiddenOnTop = true;
				else offset = r.bottom - s.top;
			}
		}

		bar.setCssProps({ "--pp-bottom-offset": `${offset}px` });
		this.setStatusBarUnder(hiddenOnTop);
	}

	/** Only write the body class on a real change; the body-class observer sees every write. */
	private setStatusBarUnder(on: boolean) {
		if (document.body.hasClass("pp-status-bar-under") !== on) document.body.toggleClass("pp-status-bar-under", on);
	}

	hide() {
		this.bar?.remove();
		this.bar = null;
		this.setStatusBarUnder(false);
	}

	private mkSkip(parent: HTMLElement, label: string, title: string, delta: number) {
		const btn = parent.createDiv("clickable-icon pp-np-skip");
		btn.textContent = label;
		btn.setAttribute("aria-label", title);
		btn.setAttribute("title", title);
		btn.addEventListener("click", () => this.ctrl.seekBy(delta));
	}

	private syncIcon() {
		if (this.playBtn) setIcon(this.playBtn, this.ctrl.playing ? "pause" : "play");
	}

	private syncProgress() {
		const d = this.ctrl.duration();
		const t = this.ctrl.currentTime;
		if (d && this.fill && !this.dragging) this.fill.style.width = `${(t / d) * 100}%`;
		if (this.timeEl) this.timeEl.textContent = `${fmt(t)} / ${fmt(d)}`;
	}

	private seekTo(clientX: number) {
		if (!this.track) return;
		const r = this.track.getBoundingClientRect();
		const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
		if (this.fill) this.fill.style.width = `${ratio * 100}%`;
		const d = this.ctrl.duration();
		if (d) this.ctrl.seek(ratio * d);
	}

	private cycleRate() {
		const rates = [0.5, 0.75, 1, 1.25, 1.5, 2];
		const i = rates.indexOf(this.ctrl.playbackRate);
		const next = rates[(i + 1) % rates.length] ?? 1;
		this.ctrl.setRate(next);
	}

	destroy() { this.hide(); }
}

// -- Embed Mirror ------------------------------------------------------------
// Inline embeds stay paused while the pooled element plays. Keep their
// scrubbers on the playback position, and let dragging one seek playback.

class EmbedMirror {
	/** Embed -> the time we last set on it, to tell our seeks from the user's. */
	private synced = new WeakMap<HTMLAudioElement, number>();

	constructor(private ctrl: Controller, private app: App, plugin: Plugin) {
		ctrl.on("timeupdate", () => this.syncAll());

		// A freshly rendered embed (note reopened, scrolled back into view)
		// starts at 0: move it to where its audio was left.
		plugin.registerDomEvent(document, "loadedmetadata", (e: Event) => {
			const t = embedAudio(e.target);
			if (!t) return;
			const pos = this.ctrl.positionOf(t.src, noteOf(this.app, t));
			if (pos) this.set(t, pos);
		}, true);

		plugin.registerDomEvent(document, "seeking", (e: Event) => {
			const t = embedAudio(e.target);
			if (!t || t.src !== this.ctrl.active?.src || noteOf(this.app, t) !== this.ctrl.notePath) return;
			const ours = this.synced.get(t);
			if (ours !== undefined && Math.abs(t.currentTime - ours) < 0.05) return;
			this.ctrl.seek(t.currentTime);
		}, true);
	}

	private syncAll() {
		const el = this.ctrl.active;
		if (!el) return;
		// Half a second of slack keeps this from seeking the embed on every tick.
		for (const t of this.embedsIn(this.ctrl.notePath)) {
			if (t.src === el.src && Math.abs(t.currentTime - el.currentTime) > 0.5) this.set(t, el.currentTime);
		}
	}

	private set(t: HTMLAudioElement, time: number) {
		this.synced.set(t, time);
		t.currentTime = time;
	}

	private embedsIn(note: string): HTMLAudioElement[] {
		const out: HTMLAudioElement[] = [];
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView && leaf.view.file?.path === note) {
				out.push(...Array.from(leaf.view.containerEl.querySelectorAll("audio")));
			}
		}
		return out;
	}
}

// -- Plugin ------------------------------------------------------------------

export default class PersistentPlayerPlugin extends Plugin {
	private ctrl!: Controller;
	private bar!: NowPlayingBar;

	onload() {
		this.ctrl = new Controller();
		this.bar = new NowPlayingBar(this.ctrl, this.app, this);

		new EmbedMirror(this.ctrl, this.app, this);

		this.registerDomEvent(document, "play", (e: Event) => {
			const t = embedAudio(e.target);
			if (!t) return;

			// Pause the inline embed so only the pooled element plays. Don't clear
			// its src: an embed without one greys out and can't be played again.
			t.pause();

			this.ctrl.loadAndPlay(t.src, noteOf(this.app, t), t.currentTime);
		}, true);

		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			this.ctrl.renameNote(oldPath, file.path);
			this.bar.attach();
		}));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			const playing = file.path === this.ctrl.notePath;
			this.ctrl.clearNote(file.path);
			if (playing) this.bar.hide();
		}));

		this.addCommand({
			id: "toggle-playback",
			name: "Play or pause",
			checkCallback: (checking) => {
				if (!this.ctrl.hasActive) return false;
				if (!checking) this.ctrl.toggle();
				return true;
			},
		});
		this.addCommand({
			id: "skip-back-5",
			name: "Skip back 5 seconds",
			checkCallback: (checking) => {
				if (!this.ctrl.hasActive) return false;
				if (!checking) this.ctrl.seekBy(-5);
				return true;
			},
		});
		this.addCommand({
			id: "skip-forward-5",
			name: "Skip forward 5 seconds",
			checkCallback: (checking) => {
				if (!this.ctrl.hasActive) return false;
				if (!checking) this.ctrl.seekBy(5);
				return true;
			},
		});
		this.addCommand({
			id: "skip-back-15",
			name: "Skip back 15 seconds",
			checkCallback: (checking) => {
				if (!this.ctrl.hasActive) return false;
				if (!checking) this.ctrl.seekBy(-15);
				return true;
			},
		});
		this.addCommand({
			id: "skip-forward-15",
			name: "Skip forward 15 seconds",
			checkCallback: (checking) => {
				if (!this.ctrl.hasActive) return false;
				if (!checking) this.ctrl.seekBy(15);
				return true;
			},
		});
	}

	onunload() {
		this.ctrl?.destroy();
		this.bar?.destroy();
	}
}

/**
 * The target if it's an audio embed in a note, not one of our pooled elements.
 * Video keeps its native inline player: the now-playing bar has no video
 * surface, so pooling a video would silently drop the picture.
 */
function embedAudio(target: EventTarget | null): HTMLAudioElement | null {
	if (!(target instanceof HTMLAudioElement)) return null;
	if (target.hasClass("pp-pooled") || !target.closest(".workspace") || !target.src) return null;
	return target;
}

/** Path of the note whose view contains el, or "" (e.g. a hover preview). */
function noteOf(app: App, el: HTMLElement): string {
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		if (leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(el)) return leaf.view.file?.path ?? "";
	}
	return "";
}

function fmt(sec: number): string {
	if (!sec || !isFinite(sec)) return "0:00";
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
}
