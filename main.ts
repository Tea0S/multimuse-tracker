import { Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder, TAbstractFile, App, requestUrl, Modal, Editor, MarkdownView, CachedMetadata, RequestUrlResponse, Platform, Scope } from 'obsidian';

interface MultimuseObsidianSettings {
	botApiUrl: string; // Bot HTTP API URL (hidden from user UI for security)
	pollInterval: number; // in minutes
	scenesFolder: string;
	basePath: string; // Obsidian Base file path (e.g., "RP Scenes/Roleplay Tracker.base")
	ownerId: string; // DEPRECATED: Auto-synced from API key, kept for backward compatibility
	userIds: string; // DEPRECATED: Auto-synced from API key, kept for backward compatibility
	enabled: boolean;
	apiKey: string; // API key for authentication (Bearer token)
	cachedUserId: string; // Cached user ID from API key (auto-populated)
	trackRoleplay: boolean; // Whether to add Roleplay property from folder path
	trackIsActive: boolean; // Whether to add Is Active? property (defaulting to true)
	/** When enabled, Characters + Participants frontmatter push to the API (keyed by Link thread id). */
	obsidianSourceOfTruth: boolean;
}

/** Canonical API base URL (no trailing slash). Old IP:port configs are migrated to this on load. */
const MULTIMUSE_API_BASE = 'https://api.multimuse.app';

const DEFAULT_SETTINGS: MultimuseObsidianSettings = {
	botApiUrl: MULTIMUSE_API_BASE,
	pollInterval: 15,
	scenesFolder: 'RP Scenes',
	basePath: '',
	ownerId: '', // Deprecated - auto-synced from API key
	userIds: '', // Deprecated - auto-synced from API key
	enabled: true,
	apiKey: '',
	cachedUserId: '', // Auto-populated from API key
	trackRoleplay: true, // Default: extract Roleplay from folder path
	trackIsActive: true, // Default: add Is Active? property
	obsidianSourceOfTruth: false,
};

interface MuseInfo {
	name: string;
	trigger: string;
	tags: string;
	owner_id: number;
	is_shared: boolean;
	muse_id?: string | null; // Optional: for API calls (alias-safe); display always uses name
}

type FrontmatterData = Record<string, unknown>;
type FrontmatterValue = string | number | boolean | string[];

interface AuthMeResponse {
	user_id?: string | number;
}

interface MusesListResponse {
	muses?: MuseInfo[];
}

interface SceneState {
	replied?: boolean | string | null;
	is_from_character?: boolean | string | null;
	timestamp?: string | null;
	your_last_post?: string | null;
	posted_since_count?: number | null;
	initializing?: boolean;
	source?: string;
}

interface SceneQueryResponse {
	tracked?: boolean;
	state?: SceneState | null;
}

interface TrackedThread {
	thread_id: string | number;
	muse_name?: string;
	muse_names?: string[];
	participants?: number | string;
	scene_path?: string;
	scene_paths?: string[];
	guild_id?: string | number | null;
	thread_name?: string;
}

interface TrackedThreadsResponse {
	threads?: TrackedThread[];
}

interface GuildMember {
	id: string;
	username: string;
	display_name: string;
}

interface GuildMembersResponse {
	members?: GuildMember[];
}

interface ApiErrorBody {
	message?: string;
}

interface MuseWrappersResolveResponse {
	header?: string;
	footer?: string;
	muse_id?: string | null;
}

const DISCORD_MESSAGE_BUDGET = 2000;
/** Max wait for an in-flight poll to yield before posting (posts must not block on long polls). */
const POLL_YIELD_MS = 600;
/** Debounce vault modify/create handlers so autosave does not stack scene API calls. */
const SCENE_CHANGE_DEBOUNCE_MS = 2500;
/** Longer debounce when pushing metadata as source of truth (reduces Discord-side work). */
const SCENE_METADATA_DEBOUNCE_MS = 8000;
/** Minimum gap between scenes/query polls for the same file (avoids Discord history scans). */
const SCENE_QUERY_COOLDOWN_MS = 45000;
/** Pause between scenes during batch poll. */
const POLL_SCENE_DELAY_MS = 500;

/** Mirrors MultiMuse core/post_wrappers.compose_chunk_for_send (single-chunk Send as Muse). */
function composeChunkForSend(
	chunk: string,
	headerBody: string,
	footerBody: string,
	budget = DISCORD_MESSAGE_BUDGET
): string {
	const museHeader = headerBody || '';
	const museFooter = footerBody || '';
	const reserved = museHeader.length + museFooter.length;
	const icBudget = Math.max(0, budget - reserved);
	const icSlice = chunk ? chunk.slice(0, icBudget) : '';

	const parts: string[] = [];
	if (museHeader) {
		parts.push(museHeader);
	}
	if (icSlice) {
		if (parts.length > 0 && !parts[parts.length - 1].endsWith('\n') && !icSlice.startsWith('\n')) {
			parts.push('\n');
		}
		parts.push(icSlice);
	} else if (parts.length === 0) {
		parts.push('');
	}
	if (museFooter) {
		const bodySoFar = parts.join('');
		if (bodySoFar && !bodySoFar.endsWith('\n')) {
			parts.push('\n');
		}
		parts.push(museFooter);
	}
	return parts.join('');
}

function canPreapplyWrappers(ic: string, header: string, footer: string): boolean {
	const composed = composeChunkForSend(ic, header, footer);
	return composed.length <= DISCORD_MESSAGE_BUDGET;
}

function parseJson<T>(text: string): T {
	return JSON.parse(text) as T;
}

function getErrorMessage(error: unknown): string {
	if (error && typeof error === 'object') {
		const details = error as { message?: unknown; text?: unknown };
		if (typeof details.message === 'string') return details.message;
		if (typeof details.text === 'string') return details.text;
	}
	return 'Unknown error';
}

function frontmatterValueToString(value: unknown, fallback = ''): string {
	if (value === null || value === undefined) return fallback;
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return fallback;
}

function sortNamesAlphabetically(names: string[]): string[] {
	return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function sortMusesAlphabetically(muses: MuseInfo[]): MuseInfo[] {
	return [...muses].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function metadataFingerprint(characters: string[], participants: number): string {
	return `${sortNamesAlphabetically(characters).join('\x1f')}|${participants}`;
}

export default class MultimuseObsidian extends Plugin {
	settings: MultimuseObsidianSettings;
	pollIntervalId: number | null = null;
	/** Bumped to cancel an in-flight poll when the user posts as muse (frees API for POST). */
	pollGeneration = 0;
	isPollRunning = false;
	/** Resolves when the current poll batch finishes (Send as Muse only yields briefly). */
	pollRunPromise: Promise<void> | null = null;
	/** Serializes poll GETs so they do not stack many concurrent calls to the API host. */
	private pollGetChain: Promise<void> = Promise.resolve();
	/** Per-path debounce timers for vault scene modify/create (avoids API pile-up while editing). */
	private sceneChangeDebounceTimers = new Map<string, number>();
	/** Per-path cooldown: last scenes/query time (reduces Discord API load on the bot). */
	private sceneQueryCooldownUntil = new Map<string, number>();
	museCache: Map<string, MuseInfo[]> = new Map(); // user_id (as string) -> muses
	recentlyCreatedFiles: Set<string> = new Set(); // Track recently created files to skip immediate checking
	// Cache of last-seen "Is Active?" value per scene path so we only sync when the user actually toggles it.
	// This prevents Obsidian from resurrecting scenes that StageHand or the bot have already ended/removed.
	sceneActiveCache: Map<string, boolean> = new Map();
	/** Last Characters+Participants fingerprint pushed per scene path (avoids API spam). */
	sceneMetadataSyncCache: Map<string, string> = new Map();
	/** True while the Create New Scene UI flow is running (blocks vault handlers from touching other notes). */
	sceneCreationInProgress = false;
	/** Swallows Enter between wizard modals so it cannot reach the editor. */
	sceneCreationKeymapScope: Scope | null = null;

	async onload() {
		await this.loadSettings();

		// Add settings tab
		this.addSettingTab(new MultimuseObsidianSettingTab(this.app, this));

		// Warm auth + muse cache in background so onload does not block the editor
		if (this.settings.apiKey) {
			void this.getUserIdFromApiKey().then(() => void this.syncMuses());
		}

		// Start polling if enabled (first poll deferred so startup stays responsive)
		if (this.settings.enabled && this.settings.apiKey) {
			this.startPolling({ deferInitialCheck: true });
		}

		// Add command to manually check now
		this.addCommand({
			id: 'check-discord-threads',
			name: 'Check Discord Threads Now',
			callback: () => {
				void this.checkAllThreads({ force: true });
			}
		});

		// Add command to toggle polling
		this.addCommand({
			id: 'toggle-polling',
			name: 'Toggle Discord Polling',
			callback: () => {
				this.settings.enabled = !this.settings.enabled;
				void this.saveSettings();
				if (this.settings.enabled) {
					this.startPolling();
					new Notice('Discord polling enabled');
				} else {
					this.stopPolling();
					new Notice('Discord polling disabled');
				}
			}
		});

		// Add command to create new scene (icon for mobile toolbar; ribbon on desktop)
		this.addCommand({
			id: 'create-scene',
			name: 'Create New Scene',
			icon: 'file-plus',
			callback: () => {
				void this.createNewScene();
			}
		});

		if (!Platform.isMobile) {
			this.addRibbonIcon('file-plus', 'Create New Scene', () => {
				void this.createNewScene();
			});
		}

		// First-time vault layout: scenes folder + Base (.base or .md) from settings
		this.addCommand({
			id: 'initialize-multimuse-workspace',
			name: 'Initialize MultiMuse workspace',
			callback: () => {
				void this.initializeMultimuseWorkspace();
			}
		});

		// Add command to insert Discord @ mention (guild members from Link property)
		this.addCommand({
			id: 'insert-mention',
			name: 'Insert @ mention',
			callback: async () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) {
					new Notice('Open a scene note (with Link in frontmatter) and try again.');
					return;
				}
				await this.insertMentionAtCursor(view);
			}
		});

		// Watch for scene file creation/modification to check state
		this.registerEvent(
			this.app.vault.on('modify', async (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					await this.handleSceneFileChange(file);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on('create', async (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					await this.handleSceneFileChange(file);
				}
			})
		);

		// Add context menu items for scene editor
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, view) => {
				menu.addItem((item) => {
					item.setTitle('Insert @ mention')
						.setIcon('at-sign')
						.onClick(async () => {
							if (view instanceof MarkdownView) {
								await this.insertMentionAtCursor(view);
							} else {
								new Notice('This feature requires a markdown view.');
							}
						});
				});
				menu.addItem((item) => {
					item.setTitle('Send as Muse')
						.setIcon('message-square')
						.onClick(async () => {
							// Type guard: ensure view is MarkdownView, not MarkdownFileInfo
							if (view instanceof MarkdownView) {
								await this.sendSelectionAsMuse(editor, view);
							} else {
								new Notice('This feature requires a markdown view.');
							}
						});
				});
			})
		);
	}

	onunload() {
		this.stopPolling();
		for (const timerId of this.sceneChangeDebounceTimers.values()) {
			window.clearTimeout(timerId);
		}
		this.sceneChangeDebounceTimers.clear();
	}

	async loadSettings() {
		const loaded = await this.loadData() as unknown;
		const savedSettings = loaded && typeof loaded === 'object'
			? loaded as Partial<MultimuseObsidianSettings>
			: {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
		// Ensure botApiUrl always uses default if empty or not set
		if (!this.settings.botApiUrl || this.settings.botApiUrl.trim() === '') {
			this.settings.botApiUrl = DEFAULT_SETTINGS.botApiUrl;
		} else {
			// Migrate old URLs to api.multimuse.app (non-breaking update after server/hostname change)
			const u = this.settings.botApiUrl.trim();
			const isOldUrl =
				u.includes(':9056') ||
				u === 'http://216.201.73.233:9056' ||
				/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(u);
			if (isOldUrl && u !== MULTIMUSE_API_BASE) {
				this.settings.botApiUrl = MULTIMUSE_API_BASE;
				await this.saveSettings();
			}
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	startPolling(opts?: { deferInitialCheck?: boolean }) {
		this.stopPolling();

		const intervalMs = this.settings.pollInterval * 60 * 1000;
		this.pollIntervalId = window.setInterval(() => {
			void this.checkAllThreads();
		}, intervalMs);

		if (!opts?.deferInitialCheck) {
			void this.checkAllThreads();
		} else {
			window.setTimeout((): void => {
				void this.checkAllThreads();
			}, 45_000);
		}
	}

	/** Serialize background GETs so they do not stack many concurrent calls to the API host. */
	private enqueuePollGet<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.pollGetChain.then(() => fn());
		this.pollGetChain = run.then((): void => undefined, (): void => undefined);
		return run;
	}

	/** Cancel in-flight poll work and drop queued poll GETs so Send as Muse can proceed. */
	private prioritizePostOverPolling(): void {
		this.pollGeneration++;
		this.pollGetChain = Promise.resolve();
	}

	/** Brief yield for the current poll loop to exit; never block posts on a full poll batch. */
	private async yieldPollSlot(maxWaitMs = POLL_YIELD_MS): Promise<void> {
		this.prioritizePostOverPolling();
		if (this.pollRunPromise === null) {
			return;
		}
		await Promise.race([
			this.pollRunPromise.catch((): void => undefined),
			new Promise<void>((resolve) => window.setTimeout(resolve, maxWaitMs)),
		]);
	}

	private async apiPostJson(
		path: string,
		body: Record<string, unknown>
	): Promise<RequestUrlResponse> {
		return await requestUrl({
			url: `${this.getBotApiUrl()}${path}`,
			method: 'POST',
			headers: this.getApiHeaders(),
			body: JSON.stringify({ ...body, fast: true }),
			throw: false
		});
	}

	stopPolling() {
		if (this.pollIntervalId !== null) {
			window.clearInterval(this.pollIntervalId);
			this.pollIntervalId = null;
		}
	}

	/**
	 * Get the bot API URL, falling back to default if not set.
	 * @returns Bot API URL string
	 */
	getBotApiUrl(): string {
		const base = !this.settings.botApiUrl || this.settings.botApiUrl.trim() === ''
			? DEFAULT_SETTINGS.botApiUrl
			: this.settings.botApiUrl.trim();
		return base.replace(/\/+$/, ''); // no trailing slash
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => window.setTimeout(resolve, ms));
	}

	/**
	 * Get headers for API requests, including Authorization header if API key is set.
	 * @returns Headers object for requestUrl
	 */
	getApiHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};
		
		// Add Authorization header if API key is configured
		if (this.settings.apiKey && this.settings.apiKey.trim() !== '') {
			headers['Authorization'] = `Bearer ${this.settings.apiKey.trim()}`;
		}
		
		return headers;
	}

	async registerScene(params: {
		threadId: string;
		userId: string;
		scenePath: string;
		characters: string[];
		participants: number;
		guildId?: string | null;
		isActive?: boolean;
	}): Promise<RequestUrlResponse> {
		const characters = sortNamesAlphabetically(params.characters);
		const body: Record<string, unknown> = {
			thread_id: params.threadId,
			user_id: params.userId,
			scene_path: params.scenePath,
			characters,
			participants: params.participants,
			is_active: params.isActive !== false,
		};
		if (params.guildId) {
			body.guild_id = params.guildId;
		}

		return await requestUrl({
			url: `${this.getBotApiUrl()}/api/v1/scenes/create`,
			method: 'POST',
			headers: this.getApiHeaders(),
			body: JSON.stringify(body),
			throw: false,
		});
	}

	/** @deprecated Use registerScene — kept as alias for internal callers migrating off threads/track-only flows. */
	async trackThread(params: {
		threadId: string;
		userId: string;
		museName: string;
		participants: number;
		scenePath?: string;
		guildId?: string | null;
		characters?: string[];
	}): Promise<RequestUrlResponse> {
		if (!params.scenePath) {
			const body: Record<string, unknown> = {
				thread_id: params.threadId,
				user_id: params.userId,
				muse_name: params.museName,
				participants: params.participants,
			};
			if (params.guildId) body.guild_id = params.guildId;
			return await requestUrl({
				url: `${this.getBotApiUrl()}/api/v1/threads/track`,
				method: 'POST',
				headers: this.getApiHeaders(),
				body: JSON.stringify(body),
				throw: false,
			});
		}

		return this.registerScene({
			threadId: params.threadId,
			userId: params.userId,
			scenePath: params.scenePath,
			characters: params.characters?.length ? params.characters : [params.museName],
			participants: params.participants,
			guildId: params.guildId,
		});
	}

	getFrontmatter(cache: CachedMetadata | null): FrontmatterData | null {
		return cache?.frontmatter ?? null;
	}

	private formatFrontmatterYaml(frontmatter: Record<string, FrontmatterValue>): string {
		const lines = ['---'];
		for (const key of Object.keys(frontmatter) as Array<keyof typeof frontmatter>) {
			const value = frontmatter[key];
			if (value === undefined) {
				continue;
			}
			if (Array.isArray(value)) {
				lines.push(`${String(key)}:`);
				for (const item of value) {
					lines.push(`  - ${item}`);
				}
			} else {
				lines.push(`${String(key)}: ${value}`);
			}
		}
		lines.push('---');
		lines.push('');
		return lines.join('\n');
	}

	/**
	 * Handle API response errors, especially authentication errors.
	 * @param response The response object from requestUrl
	 * @param context Context string for logging
	 * @returns true if error was handled, false otherwise
	 */
	handleApiError(response: RequestUrlResponse, context: string): boolean {
		if (response.status === 401) {
			const errorMsg = 'API authentication failed. Please check your API key in settings.';
			console.error(`[MultimuseObsidian] ${context}: ${errorMsg}`);
			new Notice(errorMsg);
			return true;
		}
		return false;
	}

	/**
	 * Get user ID from API key (cached or fetched fresh).
	 * @returns User ID string, or null if not available
	 */
	async getUserIdFromApiKey(): Promise<string | null> {
		// If we have a cached user ID and API key is set, use it
		if (this.settings.cachedUserId && this.settings.apiKey) {
			return this.settings.cachedUserId;
		}
		
		// If no API key, can't get user ID
		if (!this.settings.apiKey || this.settings.apiKey.trim() === '') {
			return null;
		}
		
		// Fetch user ID from API
		try {
			const url = `${this.getBotApiUrl()}/api/v1/auth/me`;
			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: this.getApiHeaders()
			});
			
			if (response.status === 200) {
				const data = parseJson<AuthMeResponse>(response.text);
				const userId = data.user_id;
				if (userId) {
					// Cache the user ID
					this.settings.cachedUserId = String(userId);
					// Also update deprecated fields for backward compatibility
					this.settings.ownerId = String(userId);
					this.settings.userIds = '';
					await this.saveSettings();
					return this.settings.cachedUserId;
				}
			} else {
				if (!this.handleApiError(response, 'getUserIdFromApiKey')) {
					console.error(`[MultimuseObsidian] Failed to get user ID from API: ${response.status}`);
				}
			}
		} catch (error) {
			console.error('[MultimuseObsidian] Error fetching user ID from API key:', error);
		}
		
		return null;
	}

	/**
	 * Collect all configured user IDs (now just from API key).
	 * @returns Array of user ID numbers
	 */
	async getAllUserIds(): Promise<string[]> {
		const userId = await this.getUserIdFromApiKey();
		if (userId) {
			return [userId];
		}
		// Fallback to old settings for backward compatibility
		const userIdSet = new Set<string>();
		if (this.settings.ownerId) {
			const ownerIds = this.settings.ownerId.split(',').map(id => id.trim()).filter(id => id.length > 0);
			ownerIds.forEach(id => userIdSet.add(id));
		}
		if (this.settings.userIds) {
			const additionalIds = this.settings.userIds.split(',').map(id => id.trim()).filter(id => id.length > 0);
			additionalIds.forEach(id => userIdSet.add(id));
		}
		return Array.from(userIdSet);
	}

	/**
	 * Get the primary user ID (from API key).
	 * @returns Primary user ID as string, or null if not configured
	 */
	async getPrimaryUserId(): Promise<string | null> {
		return await this.getUserIdFromApiKey();
	}

	/**
	 * Fetch muse list for user IDs. Uses in-memory cache when available unless forceRefresh.
	 * backgroundRefresh: return cache immediately and syncMuses() in the background.
	 */
	async getMusesForUserIds(
		userIds: string[],
		opts?: { forceRefresh?: boolean; backgroundRefresh?: boolean }
	): Promise<MuseInfo[]> {
		const primaryId = userIds[0];
		const cached = primaryId ? this.museCache.get(primaryId) : undefined;
		if (!opts?.forceRefresh && cached && cached.length > 0) {
			if (opts?.backgroundRefresh) {
				void this.syncMuses();
			}
			return cached;
		}
		return this.fetchMusesListFromApi(userIds);
	}

	findMuseMatch(muses: MuseInfo[], selectedMuse: string): MuseInfo | undefined {
		const selectedLower = selectedMuse.toLowerCase().trim();
		return muses.find(m => {
			const museLower = m.name.toLowerCase().trim();
			return museLower === selectedLower
				|| museLower.includes(selectedLower)
				|| selectedLower.includes(museLower);
		});
	}

	async resolveMuseWrappers(
		threadId: string,
		userId: string,
		muse: MuseInfo,
		museName: string
	): Promise<{ header: string; footer: string }> {
		const params = new URLSearchParams({
			thread_id: threadId,
			user_id: userId,
		});
		if (muse.muse_id) {
			params.set('muse_id', muse.muse_id);
		}
		if (museName) {
			params.set('muse_name', museName);
		}
		try {
			const response = await requestUrl({
				url: `${this.getBotApiUrl()}/api/v1/muses/wrappers/resolve?${params.toString()}`,
				method: 'GET',
				headers: this.getApiHeaders(),
				throw: false,
			});
			if (response.status !== 200) {
				return { header: '', footer: '' };
			}
			const data = parseJson<MuseWrappersResolveResponse>(response.text);
			return {
				header: (data.header ?? '').trim(),
				footer: (data.footer ?? '').trim(),
			};
		} catch (error) {
			console.debug('[MultimuseObsidian] resolveMuseWrappers:', error);
			return { header: '', footer: '' };
		}
	}

	async fetchMusesListFromApi(userIds: string[]): Promise<MuseInfo[]> {
		if (!this.settings.apiKey || userIds.length === 0) {
			return [];
		}
		const queryParam = `user_ids=${userIds.join(',')}`;
		const url = `${this.getBotApiUrl()}/api/v1/muses/list?${queryParam}`;
		const response = await requestUrl({
			url: url,
			method: 'GET',
			headers: this.getApiHeaders()
		});
		if (response.status !== 200) {
			if (!this.handleApiError(response, 'fetchMusesListFromApi')) {
				console.error(`Failed to fetch muses: ${response.status} - ${response.text}`);
			}
			return [];
		}
		const data = parseJson<MusesListResponse>(response.text);
		const muses: MuseInfo[] = sortMusesAlphabetically(data.muses || []);
		for (const userId of userIds) {
			this.museCache.set(String(userId), muses);
		}
		return muses;
	}

	async syncMuses(): Promise<void> {
		/**Sync muse names from bot API for all configured user IDs.*/
		if (!this.settings.apiKey) {
			return;
		}

		try {
			const userIds = await this.getAllUserIds();
			if (userIds.length === 0) {
				return;
			}

			const muses = await this.fetchMusesListFromApi(userIds);
			if (muses.length > 0) {
				console.log(`[MultimuseObsidian] Synced ${muses.length} muse(s) for ${userIds.length} user(s)`);
			}
		} catch (error) {
			console.error('Error syncing muses:', error);
		}
	}

	async checkAllThreads(opts?: { force?: boolean }) {
		if (!this.settings.enabled || !this.settings.apiKey) {
			return;
		}

		const run = this.checkAllThreadsViaBotApi(opts);
		this.pollRunPromise = run;
		try {
			await run;
		} finally {
			if (this.pollRunPromise === run) {
				this.pollRunPromise = null;
			}
		}
	}

	async checkAllThreadsViaBotApi(opts?: { force?: boolean }): Promise<void> {
		/**Poll tracked thread paths from the API, then active vault scenes not in the tracker map.*/
		if (!this.settings.apiKey) {
			return;
		}

		const generation = this.pollGeneration;
		this.isPollRunning = true;

		try {
			// Get primary user ID for linked scenes query
			const primaryUserIdStr = await this.getPrimaryUserId();
			if (!primaryUserIdStr) {
				return;
			}
			const primaryUserId = parseInt(primaryUserIdStr);
			if (isNaN(primaryUserId)) {
				return;
			}

			// Get all Discord-side tracked threads from the current API.
			const trackedUrl = `${this.getBotApiUrl()}/api/v1/threads/tracked?user_id=${primaryUserId}`;
			const trackedResponse = await this.enqueuePollGet(() => requestUrl({
				url: trackedUrl,
				method: 'GET',
				headers: this.getApiHeaders(),
				throw: false
			}));

			if (trackedResponse.status !== 200) {
				if (!this.handleApiError(trackedResponse, 'checkAllThreadsViaBotApi')) {
					console.error(`[MultimuseObsidian] Failed to fetch tracked threads: ${trackedResponse.status} - ${trackedResponse.text}`);
				}
				return;
			}

			const trackedData = parseJson<TrackedThreadsResponse>(trackedResponse.text);
			const trackedThreads = trackedData.threads || [];
			const scenePathMap = this.buildScenePathMap(trackedThreads);
			let updatedCount = 0;

			// Phase 1 (API-first): one scene at a time so Send as Muse can jump the queue sooner.
			for (const [scenePath, threadInfo] of scenePathMap) {
				if (generation !== this.pollGeneration) {
					break;
				}
				try {
					if (this.recentlyCreatedFiles.has(scenePath)) {
						continue;
					}

					const abstract = this.app.vault.getAbstractFileByPath(scenePath);
					if (!(abstract instanceof TFile) || abstract.extension !== 'md') {
						continue;
					}

					const file = abstract;
					const cache = this.app.metadataCache.getFileCache(file);
					const frontmatter = this.getFrontmatter(cache);
					if (!frontmatter || !this.isSceneMarkedActive(frontmatter)) {
						continue;
					}

					if (this.getCharacterNames(frontmatter).length === 0) {
						continue;
					}

					const updated = await this.queryTrackedSceneByThreadId(
						file,
						threadInfo.thread_id,
						primaryUserIdStr,
						'checkAllThreadsViaBotApi',
						opts
					);
					if (updated) {
						updatedCount++;
					}
					if (generation !== this.pollGeneration) {
						break;
					}
					await this.sleep(POLL_SCENE_DELAY_MS);
				} catch (error) {
					console.error(`Error checking tracked path ${scenePath}:`, error);
				}
			}

			// Phase 2 (orphan fallback): active vault scenes with Link not in tracker path map.
			if (generation === this.pollGeneration) {
				for (const file of this.getActiveSceneFiles()) {
					if (generation !== this.pollGeneration) {
						break;
					}
					try {
						if (scenePathMap.has(file.path)) {
							continue;
						}

						if (this.recentlyCreatedFiles.has(file.path)) {
							console.log(`[MultimuseObsidian] checkAllThreadsViaBotApi: Skipping recently created file: ${file.path}`);
							continue;
						}

						const cache = this.app.metadataCache.getFileCache(file);
						const frontmatter = this.getFrontmatter(cache);
						if (!frontmatter) {
							continue;
						}

						const link = frontmatter['Link'];
						if (typeof link !== 'string') {
							continue;
						}

						if (this.getCharacterNames(frontmatter).length === 0) {
							continue;
						}

						if (!this.extractThreadIdFromUrl(link)) {
							continue;
						}

						const updated = await this.querySceneState(file, opts);
						if (updated) {
							updatedCount++;
						}
						if (generation !== this.pollGeneration) {
							break;
						}
						await this.sleep(POLL_SCENE_DELAY_MS);
					} catch (error) {
						console.error(`Error checking ${file.path}:`, error);
					}
				}
			}

			if (updatedCount > 0) {
				new Notice(`Updated ${updatedCount} scene file(s)`);
			}
		} catch (error) {
			console.error(`[MultimuseObsidian] Error checking all threads:`, error);
		} finally {
			if (generation === this.pollGeneration) {
				this.isPollRunning = false;
			}
		}
	}

	buildScenePathMap(trackedThreads: TrackedThread[]): Map<string, TrackedThread> {
		const scenePathMap = new Map<string, TrackedThread>();
		for (const thread of trackedThreads) {
			if (thread.scene_path) {
				scenePathMap.set(thread.scene_path, thread);
			}
			for (const scenePath of thread.scene_paths || []) {
				scenePathMap.set(scenePath, thread);
			}
		}
		return scenePathMap;
	}

	async queryTrackedSceneByThreadId(
		file: TFile,
		threadId: string | number,
		userId: string,
		errorContext: string,
		opts?: { force?: boolean }
	): Promise<boolean> {
		if (!opts?.force) {
			const now = Date.now();
			const cooldownUntil = this.sceneQueryCooldownUntil.get(file.path) ?? 0;
			if (now < cooldownUntil) {
				return false;
			}
			this.sceneQueryCooldownUntil.set(file.path, now + SCENE_QUERY_COOLDOWN_MS);
		}

		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = this.getFrontmatter(cache);
		if (!cache || !frontmatter) {
			return false;
		}

		const characters = this.getSortedCharacterNames(frontmatter);
		if (characters.length === 0) {
			return false;
		}

		const charactersParam = characters.join(',');
		const participants = this.parseParticipantsFromFrontmatter(frontmatter);
		const queryUrl = `${this.getBotApiUrl()}/api/v1/scenes/query?thread_id=${threadId}&characters=${encodeURIComponent(charactersParam)}&user_id=${userId}&participants=${participants}`;

		const queryResponse = await this.enqueuePollGet(() => requestUrl({
			url: queryUrl,
			method: 'GET',
			headers: this.getApiHeaders(),
			throw: false
		}));

		if (queryResponse.status !== 200) {
			if (queryResponse.status === 401) {
				this.handleApiError(queryResponse, `${errorContext} - query scene`);
			}
			return false;
		}

		const queryData = parseJson<SceneQueryResponse>(queryResponse.text);
		if (!queryData.tracked || !queryData.state) {
			return false;
		}

		const state = queryData.state;
		const repliedValue = state.replied ?? state.is_from_character;
		if (repliedValue === undefined || repliedValue === null) {
			return false;
		}

		const normalizedState = { ...state, replied: repliedValue };
		return await this.updateSceneFromState(file, cache, normalizedState);
	}

	async querySceneState(file: TFile, opts?: { force?: boolean; skipMetadataSync?: boolean }): Promise<boolean> {
		/**Query the tracker API for a specific scene's state and update frontmatter.*/
		if (this.sceneCreationInProgress) {
			return false;
		}

		if (!opts?.force) {
			const now = Date.now();
			const cooldownUntil = this.sceneQueryCooldownUntil.get(file.path) ?? 0;
			if (now < cooldownUntil) {
				return false;
			}
			this.sceneQueryCooldownUntil.set(file.path, now + SCENE_QUERY_COOLDOWN_MS);
		}

		// Skip checking if this file was recently created by the plugin
		if (this.recentlyCreatedFiles.has(file.path)) {
			console.log(`[MultimuseObsidian] querySceneState: Skipping check for recently created file: ${file.path}`);
			return false;
		}

		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = this.getFrontmatter(cache);
		if (!cache || !frontmatter) {
			return false;
		}

		if (!this.isSceneMarkedActive(frontmatter)) {
			return false;
		}

		const link = frontmatter['Link'];
		if (typeof link !== 'string') {
			return false;
		}

		const characters = this.getSortedCharacterNames(frontmatter);
		if (characters.length === 0) {
			return false;
		}

		const threadId = this.extractThreadIdFromUrl(link);
		if (!threadId) {
			return false;
		}

		if (this.settings.obsidianSourceOfTruth && !opts?.skipMetadataSync) {
			await this.syncSceneMetadataToApi(file, { frontmatter });
		}

		try {
			const charactersParam = characters.join(',');
			// Use primary user ID for query
			const primaryUserId = await this.getPrimaryUserId();
			if (!primaryUserId) {
				return false;
			}
			const url = `${this.getBotApiUrl()}/api/v1/scenes/query?thread_id=${threadId}&characters=${encodeURIComponent(charactersParam)}&user_id=${primaryUserId}&participants=${this.parseParticipantsFromFrontmatter(frontmatter)}`;

			const response = await this.enqueuePollGet(() => requestUrl({
				url: url,
				method: 'GET',
				headers: this.getApiHeaders(),
				throw: false
			}));

			if (response.status !== 200) {
				if (!this.handleApiError(response, `querySceneState for ${file.path}`)) {
					console.error(`[MultimuseObsidian] API error for ${file.path}: ${response.status} - ${response.text}`);
				}
				return false;
			}

			const data = parseJson<SceneQueryResponse>(response.text);

			if ((!data.tracked || !data.state) && this.settings.obsidianSourceOfTruth && !opts?.skipMetadataSync) {
				await this.syncSceneMetadataToApi(file, { frontmatter });
				const retryResponse = await this.enqueuePollGet(() => requestUrl({
					url: url,
					method: 'GET',
					headers: this.getApiHeaders(),
					throw: false,
				}));
				if (retryResponse.status === 200) {
					const retryData = parseJson<SceneQueryResponse>(retryResponse.text);
					if (retryData.tracked && retryData.state) {
						const retryReplied = retryData.state.replied ?? retryData.state.is_from_character;
						if (retryReplied !== undefined && retryReplied !== null) {
							return await this.updateSceneFromState(file, cache, { ...retryData.state, replied: retryReplied });
						}
					}
				}
			}
			
			// If scene is not tracked, don't update anything
			if (!data.tracked || !data.state) {
				console.log(`[MultimuseObsidian] Scene ${file.basename} is not tracked (tracked: ${data.tracked}, has state: ${!!data.state}) - skipping update`);
				return false;
			}

			const state = data.state;
			// API may return 'replied' and/or 'is_from_character' (same meaning)
			const repliedValue = state.replied ?? state.is_from_character;
			console.log(`[MultimuseObsidian] Scene ${file.basename} is tracked. State:`, JSON.stringify(state), 'repliedValue=', repliedValue);
			
			// Only update if we have a definite replied value (replied or is_from_character)
			if (repliedValue === undefined || repliedValue === null) {
				console.log(`[MultimuseObsidian] Scene ${file.basename} has undefined/null replied value - skipping update`);
				return false;
			}
			// Normalize state so updateSceneFromState sees a single field
			const normalizedState = { ...state, replied: repliedValue };
			return await this.updateSceneFromState(file, cache, normalizedState);
		} catch (error) {
			console.error(`[MultimuseObsidian] Error querying scene state for ${file.path}:`, error);
			return false;
		}
	}

	async updateSceneFromState(file: TFile, cache: CachedMetadata, state: SceneState): Promise<boolean> {
		/**Update scene frontmatter from API state data.*/
		let updated = false;
		const frontmatter = this.getFrontmatter(cache);
		if (!frontmatter) {
			return false;
		}

		// Use replied or is_from_character (API may send either)
		const repliedRaw = state.replied ?? state.is_from_character;
		if (repliedRaw === undefined || repliedRaw === null) {
			if (state.initializing) {
				console.log(`[MultimuseObsidian] ${file.basename}: API still initializing turn state - skipping update`);
			} else {
				console.log(`[MultimuseObsidian] ${file.basename}: state.replied/is_from_character is undefined/null - skipping update`);
			}
			return false;
		}

		// Legacy guard for uninitialized in-memory state without thread_tracker anchors.
		// thread_tracker responses include DB anchors or source=thread_tracker — trust those.
		const fromThreadTracker = state.source === 'thread_tracker';
		if (
			!fromThreadTracker &&
			state.timestamp === null &&
			state.your_last_post === null &&
			(state.posted_since_count ?? 0) === 0
		) {
			console.log(`[MultimuseObsidian] ${file.basename}: State appears invalid (timestamp and your_last_post are null) - likely bot can't access channel. Skipping update to prevent incorrect "Replied?" value.`);
			return false;
		}

		// Update Replied? field - normalize boolean values for comparison
		const currentRepliedRaw = frontmatter['Replied?'];
		// Handle both boolean and string values
		const currentReplied = currentRepliedRaw === true || currentRepliedRaw === 'true' || currentRepliedRaw === 'True';
		// true = you've replied (no need to reply), false = need to reply
		const shouldBeReplied = repliedRaw === true || repliedRaw === 'true';

		console.log(`[MultimuseObsidian] ${file.basename}: Current Replied?=${currentReplied}, API replied=${repliedRaw}, shouldBeReplied=${shouldBeReplied}`);

		// Always apply API state so Replied? unchecks when someone replies back (your turn again)
		if (currentReplied !== shouldBeReplied) {
			console.log(`[MultimuseObsidian] ${file.basename}: Updated Replied? to ${shouldBeReplied}`);
			await this.updateFrontmatter(file, 'Replied?', shouldBeReplied);
			updated = true;
		}



		// Do NOT overwrite Participants from API/thread state. The plugin uses thread tracker
		// for reply state only; Participants is always user-editable in frontmatter so the user
		// can set it regardless of whether the scene is linked to a tracked thread.

		return updated;
	}


	async handleSceneFileChange(file: TFile): Promise<void> {
		/**Handle scene file creation/modification - debounced so autosave does not flood the API.*/
		if (this.sceneCreationInProgress) {
			return;
		}

		if (!file.path.startsWith(this.settings.scenesFolder + '/')) {
			return;
		}

		if (!this.settings.apiKey || !this.settings.enabled) {
			return;
		}

		if (this.recentlyCreatedFiles.has(file.path)) {
			console.log(`[MultimuseObsidian] Skipping check for recently created file: ${file.path}`);
			return;
		}

		const existing = this.sceneChangeDebounceTimers.get(file.path);
		if (existing !== undefined) {
			window.clearTimeout(existing);
		}

		const debounceMs = this.settings.obsidianSourceOfTruth
			? SCENE_METADATA_DEBOUNCE_MS
			: SCENE_CHANGE_DEBOUNCE_MS;

		const timerId = window.setTimeout(() => {
			this.sceneChangeDebounceTimers.delete(file.path);
			void this.processSceneFileChange(file);
		}, debounceMs);
		this.sceneChangeDebounceTimers.set(file.path, timerId);
	}

	private async processSceneFileChange(file: TFile): Promise<void> {
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = this.getFrontmatter(cache);
		if (!frontmatter) {
			return;
		}

		await this.syncSceneActiveStatusToApi(file, cache);

		if (!this.isSceneMarkedActive(frontmatter)) {
			this.clearSceneSyncCaches(file.path);
			return;
		}

		const prevFingerprint = this.sceneMetadataSyncCache.get(file.path);
		await this.syncSceneMetadataToApi(file, cache);
		const metadataPushed = this.sceneMetadataSyncCache.get(file.path) !== prevFingerprint
			&& this.sceneMetadataSyncCache.has(file.path);

		// Metadata push already hit the bot; skip an immediate query (reduces Discord API load).
		if (metadataPushed) {
			return;
		}

		const now = Date.now();
		const cooldownUntil = this.sceneQueryCooldownUntil.get(file.path) ?? 0;
		if (now < cooldownUntil) {
			return;
		}
		this.sceneQueryCooldownUntil.set(file.path, now + SCENE_QUERY_COOLDOWN_MS);

		try {
			await this.querySceneState(file, { skipMetadataSync: true });
		} catch (error) {
			console.debug(`Error checking scene ${file.path}:`, error);
		}
	}

	/**
	 * Sync the scene's "Is Active?" frontmatter to the MultiMuse API.
	 * When unchecked, the bot sets is_active=0 so the scene is removed from the tracker.
	 *
	 * IMPORTANT: The bot/database is the source of truth for is_active. Obsidian should only
	 * push changes when the user actually toggles "Is Active?" in the note. To avoid
	 * resurrecting scenes that were ended from StageHand or `/scene end`, this method
	 * compares the current frontmatter value against a cached last-seen value and only
	 * calls the API when it has changed.
	 */
	async syncSceneActiveStatusToApi(file: TFile, cache: { frontmatter?: Record<string, unknown> }): Promise<void> {
		const link = cache.frontmatter?.['Link'];
		if (!link) return; // No Link = not a tracked scene

		const primaryUserId = await this.getPrimaryUserId();
		if (!primaryUserId) return;

		if (typeof link !== 'string') return;

		const threadId = this.extractThreadIdFromUrl(link);
		const raw = cache.frontmatter?.['Is Active?'];
		const isActive = raw !== false && raw !== 'false';

		// Only sync when the value has actually changed in this Obsidian session.
		// - First time we see a file, record the value but do NOT push to the API.
		// - Subsequent changes (true -> false, false -> true) are treated as user intent.
		const prev = this.sceneActiveCache.get(file.path);
		if (prev === undefined) {
			this.sceneActiveCache.set(file.path, isActive);
			// Do not call the API on first sight of a file; this avoids overwriting
			// scenes that were ended or deactivated from StageHand while Obsidian was closed.
			return;
		}
		if (prev === isActive) {
			// No change in "Is Active?" — nothing to sync.
			return;
		}

		try {
			const body: Record<string, unknown> = {
				scene_path: file.path,
				user_id: primaryUserId,
				is_active: isActive
			};
			if (threadId) body.thread_id = threadId;

			const response = await requestUrl({
				url: `${this.getBotApiUrl()}/api/v1/scenes/update-active`,
				method: 'POST',
				headers: { ...this.getApiHeaders(), 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (response.status === 200) {
				this.sceneActiveCache.set(file.path, isActive);
				if (!isActive) {
					this.clearSceneSyncCaches(file.path);
					console.log(`[MultimuseObsidian] Synced Is Active?=false for ${file.path} - removed from tracker`);
				}
			}
		} catch (e) {
			console.debug(`[MultimuseObsidian] Could not sync Is Active? for ${file.path}:`, e);
		}
	}

	/**
	 * Sync Characters and/or Participants frontmatter to MultiMuse.
	 * When obsidianSourceOfTruth is on, pushes both via scenes/create (keyed by Link thread id).
	 * Otherwise only Participants changes are pushed (legacy behaviour).
	 */
	async syncSceneMetadataToApi(file: TFile, cache: { frontmatter?: Record<string, unknown> }): Promise<void> {
		const link = cache.frontmatter?.['Link'];
		if (!link || typeof link !== 'string') return;

		const frontmatter = cache.frontmatter;
		if (!frontmatter || !this.isSceneMarkedActive(frontmatter)) {
			return;
		}

		const primaryUserId = await this.getPrimaryUserId();
		if (!primaryUserId) return;
		const characters = this.getSortedCharacterNames(frontmatter);
		if (characters.length === 0) return;

		const participants = this.parseParticipantsFromFrontmatter(frontmatter);
		const fingerprint = metadataFingerprint(characters, participants);
		if (this.sceneMetadataSyncCache.get(file.path) === fingerprint) {
			return;
		}

		const threadId = this.extractThreadIdFromUrl(link);
		if (!threadId) return;

		const threadInfo = this.extractThreadInfoFromUrl(link);

		try {
			if (this.settings.obsidianSourceOfTruth) {
				const response = await this.registerScene({
					threadId,
					userId: primaryUserId,
					scenePath: file.path,
					characters,
					participants,
					guildId: threadInfo?.guildId ?? null,
					isActive: true,
				});
				if (response.status === 200) {
					this.sceneMetadataSyncCache.set(file.path, fingerprint);
					console.debug(`[MultimuseObsidian] Synced scene metadata (source of truth) for ${file.path}`);
				}
				return;
			}

			const body: Record<string, unknown> = {
				scene_path: file.path,
				user_id: primaryUserId,
				participants,
				thread_id: threadId,
			};

			const response = await requestUrl({
				url: `${this.getBotApiUrl()}/api/v1/scenes/update-participants`,
				method: 'POST',
				headers: { ...this.getApiHeaders(), 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				throw: false,
			});
			if (response.status === 200) {
				this.sceneMetadataSyncCache.set(file.path, fingerprint);
				console.debug(`[MultimuseObsidian] Synced Participants=${participants} for ${file.path}`);
			}
		} catch (e) {
			console.debug(`[MultimuseObsidian] Could not sync scene metadata for ${file.path}:`, e);
		}
	}

	getSceneFiles(): TFile[] {
		const folder = this.app.vault.getAbstractFileByPath(this.settings.scenesFolder);
		if (!folder) {
			return [];
		}

		const files: TFile[] = [];
		this.collectMarkdownFiles(folder, files);
		return files;
	}

	/** True when the scene should be polled/synced. Explicit Is Active? = false always skips API work. */
	isSceneMarkedActive(frontmatter: FrontmatterData): boolean {
		const raw = frontmatter['Is Active?'];
		return raw !== false && raw !== 'false';
	}

	private clearSceneSyncCaches(filePath: string): void {
		this.sceneMetadataSyncCache.delete(filePath);
		this.sceneQueryCooldownUntil.delete(filePath);
		const debounceTimer = this.sceneChangeDebounceTimers.get(filePath);
		if (debounceTimer !== undefined) {
			window.clearTimeout(debounceTimer);
			this.sceneChangeDebounceTimers.delete(filePath);
		}
	}

	/** Scene markdown files under the scenes folder with Is Active? true (or untracked when toggle is off). */
	getActiveSceneFiles(): TFile[] {
		const active: TFile[] = [];
		for (const file of this.getSceneFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			const frontmatter = this.getFrontmatter(cache);
			if (!frontmatter || !this.isSceneMarkedActive(frontmatter)) {
				continue;
			}
			active.push(file);
		}
		return active;
	}

	/** Build a map of thread_id (from Link property) -> TFile for all scene files that have a valid Link. */
	getExistingSceneLinksByThreadId(): Map<string, TFile> {
		const map = new Map<string, TFile>();
		for (const file of this.getSceneFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			const frontmatter = this.getFrontmatter(cache);
			const link = frontmatter?.['Link'];
			if (!link || typeof link !== 'string') continue;
			const threadId = this.extractThreadIdFromUrl(link);
			if (threadId) map.set(threadId, file);
		}
		return map;
	}

	collectMarkdownFiles(fileOrFolder: TAbstractFile, files: TFile[]): void {
		if (fileOrFolder instanceof TFile && fileOrFolder.extension === 'md') {
			files.push(fileOrFolder);
		} else if (fileOrFolder instanceof TFolder) {
			for (const child of fileOrFolder.children) {
				this.collectMarkdownFiles(child, files);
			}
		}
	}


	getCharacterNames(frontmatter: FrontmatterData): string[] {
		const characters = frontmatter['Characters'];
		if (!characters) {
			return [];
		}

		// Handle both array and single value
		if (Array.isArray(characters)) {
			return characters
				.map(c => frontmatterValueToString(c).trim())
				.filter(c => c.length > 0);
		} else if (typeof characters === 'string') {
			// Handle comma-separated string
			return characters.split(',').map(c => c.trim()).filter(c => c.length > 0);
		} else if (typeof characters === 'number' || typeof characters === 'boolean') {
			return [frontmatterValueToString(characters).trim()];
		}

		return [];
	}

	getSortedCharacterNames(frontmatter: FrontmatterData): string[] {
		return sortNamesAlphabetically(this.getCharacterNames(frontmatter));
	}

	parseParticipantsFromFrontmatter(frontmatter: FrontmatterData): number {
		const raw = frontmatter['Participants'];
		const participants = typeof raw === 'number' && raw >= 1
			? raw
			: typeof raw === 'string'
				? parseInt(raw, 10)
				: 2;
		if (isNaN(participants) || participants < 1) {
			return 2;
		}
		return Math.min(participants, 99);
	}


	extractThreadIdFromUrl(url: string): string | null {
		if (!url || typeof url !== 'string') {
			return null;
		}

		// Discord URL formats:
		// Thread URL: https://discord.com/channels/GUILD_ID/CHANNEL_ID/THREAD_ID (3 IDs - extract last)
		// Channel/Thread URL: https://discord.com/channels/GUILD_ID/THREAD_ID (2 IDs - extract second)
		// Also handle canary.discord.com
		const match3 = url.match(/discord(?:app)?(?:canary)?\.com\/channels\/\d+\/\d+\/(\d+)/);
		if (match3) {
			return match3[1]; // Thread URL with 3 IDs
		}
		
		const match2 = url.match(/discord(?:app)?(?:canary)?\.com\/channels\/\d+\/(\d+)/);
		if (match2) {
			return match2[1]; // Channel/Thread URL with 2 IDs (thread ID is the channel ID)
		}
		
		return null;
	}


	async updateFrontmatter(file: TFile, key: string, value: FrontmatterValue): Promise<void> {
		const content = await this.app.vault.read(file);
		
		// Parse frontmatter
		const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
		const match = content.match(frontmatterRegex);
		
		if (!match) {
			console.error(`[MultimuseObsidian] No frontmatter found in ${file.path}`);
			return;
		}

		let frontmatterText = match[1];
		const body = content.slice(match[0].length);

		// Escape special regex characters in the key
		const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		
		// Format value for YAML (handle booleans, strings, etc.)
		let formattedValue: string;
		if (typeof value === 'boolean') {
			formattedValue = value.toString(); // "true" or "false"
		} else if (typeof value === 'string') {
			formattedValue = value;
		} else {
			formattedValue = String(value);
		}
		
		// Update the key-value pair - match the key at the start of a line
		// Handle both single-line and multi-line values
		// Match any value after the colon (including true/false, "true"/"false", etc.)
		const keyRegex = new RegExp(`^${escapedKey}:\\s*(.+)$`, 'gm');
		const keyMatch = frontmatterText.match(keyRegex);

		if (keyMatch) {
			// Replace ALL occurrences of the key (in case there are duplicates)
			// Always update to the new value
			frontmatterText = frontmatterText.replace(keyRegex, `${key}: ${formattedValue}`);
		} else {
			// Add new key-value pair at the end
			frontmatterText += `\n${key}: ${formattedValue}`;
		}

		// Reconstruct file content
		const newContent = `---\n${frontmatterText}\n---\n${body}`;
		
		await this.app.vault.modify(file, newContent);
	}

	// ========= NEW COMMAND METHODS =========

	async createNewScene(): Promise<void> {
		/**Create a new scene with muse selection, thread link, location, name, and participants.*/
		if (this.sceneCreationInProgress) {
			return;
		}

		if (!this.settings.apiKey) {
			new Notice('API key must be configured in settings.');
			return;
		}

		this.sceneCreationInProgress = true;
		this.sceneCreationKeymapScope = new Scope(this.app.scope);
		this.sceneCreationKeymapScope.register([], 'Enter', (evt) => {
			evt.preventDefault();
			return false;
		});
		this.app.keymap.pushScope(this.sceneCreationKeymapScope);
		try {
			// Flush the open note so Properties does not merge new-scene fields into it during the modal flow.
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView?.file) {
				await activeView.save();
			}
			await this.runCreateNewSceneFlow();
		} finally {
			if (this.sceneCreationKeymapScope) {
				this.app.keymap.popScope(this.sceneCreationKeymapScope);
				this.sceneCreationKeymapScope = null;
			}
			this.sceneCreationInProgress = false;
		}
	}

	async runCreateNewSceneFlow(): Promise<void> {
		// 1) Get muses from bot API for all configured user IDs
		let muses: MuseInfo[] = [];
		try {
			// Collect all user IDs (deduplicated) - now from API key
			const userIds = await this.getAllUserIds();
			if (userIds.length === 0) {
				new Notice('Failed to get user ID from API key. Please check your API key in settings.');
				return;
			}

			// Always use user_ids parameter for consistency with API
			const queryParam = `user_ids=${userIds.join(',')}`;

			const url = `${this.getBotApiUrl()}/api/v1/muses/list?${queryParam}`;
			console.log(`[MultimuseObsidian] Fetching muses for ${userIds.length} user(s): ${userIds.join(', ')}`);
			console.log(`[MultimuseObsidian] API URL: ${url}`);

			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: this.getApiHeaders()
			});

			if (response.status === 200) {
				const data = parseJson<MusesListResponse>(response.text);
				muses = data.muses || [];
				console.log(`[MultimuseObsidian] Found ${muses.length} muse(s) from ${userIds.length} user(s)`);
				if (muses.length > 0) {
					const ownerIds = muses.map(m => m.owner_id);
					const uniqueOwners = [...new Set(ownerIds)];
					console.log(`[MultimuseObsidian] Muses from ${uniqueOwners.length} owner(s): ${uniqueOwners.join(', ')}`);
					console.log(`[MultimuseObsidian] Muse names: ${muses.map(m => m.name).join(', ')}`);
				}
			} else {
				if (!this.handleApiError(response, 'createNewScene - fetch muses')) {
					console.error(`[MultimuseObsidian] API error: ${response.status} - ${response.text}`);
					new Notice(`Failed to fetch muses: ${response.status}`);
				}
				return;
			}
		} catch (error) {
			console.error('Error fetching muses:', error);
			new Notice('Failed to fetch muses from bot API. Check your API URL and connection.');
			return;
		}

		if (muses.length === 0) {
			new Notice('No muses found. Make sure you have muses created in Discord.');
			return;
		}

		muses.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

		// 2) Select muse
		const museOptions = muses.map(m => m.name);
		const selectedMuseIndex = await this.showSuggester(museOptions, museOptions, 'Select a muse');
		if (selectedMuseIndex === null || selectedMuseIndex < 0) return;

		const selectedMuse = muses[selectedMuseIndex];

		// 3) Get Discord thread/channel link
		const threadUrl = await this.showInputPrompt('Enter Discord thread/channel URL');
		if (!threadUrl) return;

		const threadInfo = this.extractThreadInfoFromUrl(threadUrl);
		if (!threadInfo) {
			new Notice('Invalid Discord URL format.');
			return;
		}

		// 4) Get location (RP folder) - pass muse name for context
		console.log(`[MultimuseObsidian] createNewScene: About to select location for muse "${selectedMuse.name}"`);
		const location = await this.selectSceneLocation(`muse "${selectedMuse.name}"`);
		console.log(`[MultimuseObsidian] createNewScene: Selected location: ${location || 'null (cancelled)'}`);
		if (!location) return;

		// 5) Get scene name
		const sceneName = await this.showInputPrompt('Enter scene name', `${selectedMuse.name} - Scene`);
		if (!sceneName) return;

		// 6) Get participants
		const participantsStr = await this.showInputPrompt('Number of participants (default: 2)', '2');
		const participants = parseInt(participantsStr) || 2;

		// 7) Create scene file
		const filePath = `${location}/${sceneName}.md`;
		const frontmatter: Record<string, FrontmatterValue> = {
			'Link': threadUrl,
			'Characters': [selectedMuse.name],
			'Participants': participants,
			'Replied?': false,
			'Created': new Date().toISOString().split('T')[0],
		};

		// Add Roleplay property if enabled
		if (this.settings.trackRoleplay) {
			const roleplay = this.extractRoleplayFromPath(location);
			if (roleplay) {
				frontmatter['Roleplay'] = roleplay;
			}
		}

		// Add Is Active? property if enabled
		if (this.settings.trackIsActive) {
			frontmatter['Is Active?'] = true;
		}

		const content = this.formatFrontmatterYaml(frontmatter);

		// Ensure all folders in the path exist (create recursively)
		const segs = location.split("/").filter(Boolean);
		let currentPath = segs[0];
		
		// Ensure root folder exists
		let abs = this.app.vault.getAbstractFileByPath(currentPath);
		if (!abs) {
			await this.app.vault.createFolder(currentPath);
		}
		
		// Create nested folders
		for (let i = 1; i < segs.length; i++) {
			currentPath += "/" + segs[i];
			const folder = this.app.vault.getAbstractFileByPath(currentPath);
			if (!folder) {
				await this.app.vault.createFolder(currentPath);
			}
		}

		// Create file
		const createdFile = await this.app.vault.create(filePath, content);
		
		// Mark this file as recently created to skip immediate checking
		this.recentlyCreatedFiles.add(filePath);
		// Remove from the set after 60 seconds (enough time for the scene to be registered and settled with the API)
		window.setTimeout(() => {
			this.recentlyCreatedFiles.delete(filePath);
			console.log(`[MultimuseObsidian] Removed ${filePath} from recently created files - will now be checked by polling`);
		}, 60000);

		// 8) Link the vault scene to the current Discord-side thread tracker.
		try {
			console.debug(`Tracking scene: threadId=${threadInfo.threadId}, guildId=${threadInfo.guildId}, channelId=${threadInfo.channelId}, url=${threadUrl}`);
			
			// Convert IDs to strings to avoid JavaScript number precision loss
			// Discord IDs are larger than Number.MAX_SAFE_INTEGER, so we send them as strings
			// Use primary user ID for thread tracking
			const primaryUserId = await this.getPrimaryUserId();
			if (!primaryUserId) {
				new Notice('Failed to get user ID from API key. Please check your API key in settings.');
				return;
			}
			
			const registerResponse = await this.registerScene({
				threadId: threadInfo.threadId,
				userId: primaryUserId,
				scenePath: createdFile.path,
				characters: [selectedMuse.name],
				participants: participants,
				guildId: threadInfo.guildId || null,
				isActive: true,
			});
			
			console.debug(`Scene registration response: ${registerResponse.status} - ${registerResponse.text}`);

			if (registerResponse.status === 200) {
				this.sceneMetadataSyncCache.set(
					createdFile.path,
					metadataFingerprint([selectedMuse.name], participants)
				);
				// Add to Base if configured
				try {
					if (this.settings.basePath) {
						await this.addSceneToBase(createdFile, frontmatter);
					}
				} catch (baseError) {
					console.error('Error adding to Base (non-fatal):', baseError);
				}

				new Notice(`Scene created: ${sceneName}`);
				await this.app.workspace.getLeaf(true).openFile(createdFile);
			} else if (registerResponse.status === 401) {
				// Authentication error - show helpful message
				this.handleApiError(registerResponse, 'createNewScene - track thread');
				new Notice('Scene created but failed to track with bot: Authentication failed. Check your API key.');
			} else {
				const errorText = registerResponse.text || 'Unknown error';
				console.error(`Failed to track thread: ${registerResponse.status} - ${errorText}`);
				new Notice(`Scene created but failed to track with bot: ${registerResponse.status}`);
			}
		} catch (error) {
			// Log the full error for debugging
			console.error('Error tracking thread:', error);
			const errorMessage = getErrorMessage(error);
			console.error('Error details:', errorMessage);
			
			new Notice(`Scene created but failed to track with bot: ${errorMessage}`);
		}
	}

	// ========= BASE INTEGRATION =========

	/** Ensure each segment of `folderPath` exists under the vault root. */
	async ensureFolderPathExists(folderPath: string): Promise<void> {
		const normalized = folderPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
		if (!normalized) return;
		const parts = normalized.split('/').filter((p) => p.length > 0);
		let acc = '';
		for (const part of parts) {
			acc = acc ? `${acc}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(acc);
			if (!existing) {
				await this.app.vault.createFolder(acc);
			}
		}
	}

	/**
	 * YAML for a native Obsidian Base listing scene notes under the scenes folder,
	 * with columns aligned to MultiMuse frontmatter and plugin toggles.
	 */
	buildSceneBaseYaml(scenesFolder: string): string {
		const folderLit = JSON.stringify(scenesFolder);
		const lines: string[] = [
			'# MultiMuse Tracker — generated Base (safe to edit in Obsidian)',
			'filters:',
			'  and:',
			'    - file.ext == "md"',
			`    - file.inFolder(${folderLit})`,
		];
		if (this.settings.trackIsActive) {
			lines.push('    - \'note["Is Active?"] == true\'');
		}
		lines.push(
			'properties:',
			'  file.name:',
			'    displayName: Scene',
			'  file.path:',
			'    displayName: Path',
			'  Link:',
			'    displayName: Link',
			'  Characters:',
			'    displayName: Characters',
		);
		if (this.settings.trackRoleplay) {
			lines.push('  Roleplay:', '    displayName: Roleplay');
		}
		lines.push(
			'  Participants:',
			'    displayName: Participants',
			"  'Replied?':",
			'    displayName: Replied?',
		);
		if (this.settings.trackIsActive) {
			lines.push("  'Is Active?':", '    displayName: Is Active?');
		}
		lines.push(
			'  Created:',
			'    displayName: Created',
			'views:',
			'  - type: table',
			'    name: Roleplay Tracker',
			'    order:',
			'      - file.name',
			'      - Link',
			'      - Characters',
		);
		if (this.settings.trackRoleplay) {
			lines.push('      - Roleplay');
		}
		lines.push(
			'      - Participants',
			"      - 'Replied?'",
		);
		if (this.settings.trackIsActive) {
			lines.push("      - 'Is Active?'");
		}
		lines.push('      - Created');
		return lines.join('\n') + '\n';
	}

	/** Starter markdown table compatible with this plugin's markdown Base integration. */
	buildMarkdownTrackerStub(): string {
		return [
			'# MultiMuse scene tracker',
			'',
			'Rows below are appended when you create or sync scenes if **Obsidian Base Path** points to this file.',
			'',
			'| Scene | Characters | Link | Participants | Replied? |',
			'|-------|------------|------|--------------|----------|',
			'',
		].join('\n');
	}

	/**
	 * Create the configured scenes folder (if missing), then a new Base or markdown tracker file.
	 * If **Obsidian Base Path** is empty, creates `<Scenes Folder>/Roleplay Tracker.base` and saves that path.
	 */
	async initializeMultimuseWorkspace(): Promise<void> {
		const scenesFolder = this.settings.scenesFolder
			.trim()
			.replace(/\\/g, '/')
			.replace(/^\/+|\/+$/g, '');
		if (!scenesFolder) {
			new Notice('Set Scenes Folder in Multimuse Tracker settings first.');
			return;
		}

		const configuredBase = this.settings.basePath
			.trim()
			.replace(/\\/g, '/')
			.replace(/^\/+|\/+$/g, '');

		let targetBasePath: string;
		if (!configuredBase) {
			targetBasePath = `${scenesFolder}/Roleplay Tracker.base`;
		} else {
			targetBasePath = configuredBase;
		}

		const ext = (targetBasePath.split('.').pop() || '').toLowerCase();
		if (ext !== 'base' && ext !== 'md') {
			new Notice('Obsidian Base Path must end in .base or .md, or leave it empty to create Roleplay Tracker.base under your scenes folder.');
			return;
		}

		try {
			await this.ensureFolderPathExists(scenesFolder);

			const existing = this.app.vault.getAbstractFileByPath(targetBasePath);
			if (existing) {
				new Notice(`Already exists: ${targetBasePath}. Remove it or change Obsidian Base Path in settings, then run again.`);
				return;
			}

			const parent = targetBasePath.includes('/')
				? targetBasePath.slice(0, targetBasePath.lastIndexOf('/'))
				: '';
			if (parent) {
				await this.ensureFolderPathExists(parent);
			}

			const body = ext === 'base'
				? this.buildSceneBaseYaml(scenesFolder)
				: this.buildMarkdownTrackerStub();

			await this.app.vault.create(targetBasePath, body);

			this.settings.basePath = targetBasePath;
			await this.saveSettings();

			new Notice(
				ext === 'base'
					? `Created Base and set path: ${targetBasePath}`
					: `Created markdown tracker and set path: ${targetBasePath}`,
			);
		} catch (error) {
			console.error('[MultimuseObsidian] initializeMultimuseWorkspace:', error);
			new Notice(`Could not initialize workspace: ${getErrorMessage(error)}`);
		}
	}

	async addSceneToBase(file: TFile, frontmatter: FrontmatterData): Promise<void> {
		/**Add scene to Obsidian Base with characters as variables.*/
		if (!this.settings.basePath) return;

		try {
			const baseFile = this.app.vault.getAbstractFileByPath(this.settings.basePath);
			if (!baseFile || !(baseFile instanceof TFile)) {
				return;
			}

			// Skip .base files - they use a special format that we shouldn't modify directly
			// Base plugin should handle its own format
			if (baseFile.extension === 'base') {
				console.log(`[MultimuseObsidian] Skipping Base integration for .base file - use Base plugin UI to add records`);
				return;
			}

			// Only handle .md files with markdown tables
			if (baseFile.extension !== 'md') {
				return;
			}

			// Read Base file
			const baseContent = await this.app.vault.read(baseFile);
			
			// Extract characters from frontmatter
			const characters = this.getCharacterNames(frontmatter);
			const link = frontmatterValueToString(frontmatter['Link']);
			const participants = frontmatterValueToString(frontmatter['Participants'], '2');
			const replied = frontmatterValueToString(frontmatter['Replied?'], 'false');

			// Check if scene already exists in table
			if (baseContent.includes(`| ${file.basename} |`)) {
				// Scene already exists, skip
				return;
			}

			// Add record as markdown table row
			const recordLine = `| ${file.basename} | ${characters.join(', ')} | ${link} | ${participants} | ${replied} |\n`;
			
			// Check if Base has table structure
			if (baseContent.includes('|')) {
				// Append to existing table
				await this.app.vault.modify(baseFile, baseContent + recordLine);
			} else {
				// Create table structure
				const tableHeader = '| Scene | Characters | Link | Participants | Replied? |\n|-------|------------|------|--------------|----------|\n';
				await this.app.vault.modify(baseFile, tableHeader + recordLine);
			}
		} catch (error) {
			console.error('Error adding scene to Base:', error);
		}
	}

	// ========= HELPER METHODS =========

	extractThreadInfoFromUrl(url: string): { threadId: string; guildId: string | null; channelId?: string } | null {
		// Discord URL formats:
		// Thread in channel: https://discord.com/channels/GUILD_ID/CHANNEL_ID/THREAD_ID
		// Standalone thread: https://discord.com/channels/GUILD_ID/THREAD_ID (thread ID = channel ID)
		const match3 = url.match(/discord(?:app)?(?:canary)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
		if (match3) {
			// 3-part URL: GUILD_ID/CHANNEL_ID/THREAD_ID - thread ID is the last one
			return { guildId: match3[1], channelId: match3[2], threadId: match3[3] };
		}
		
		const match2 = url.match(/discord(?:app)?(?:canary)?\.com\/channels\/(\d+)\/(\d+)/);
		if (match2) {
			// 2-part URL: GUILD_ID/THREAD_ID - could be a standalone thread or channel
			// In this case, the thread ID is the same as the channel ID
			return { guildId: match2[1], threadId: match2[2] };
		}
		
		return null;
	}

	/**
	 * Extract the Roleplay property from a folder path.
	 * Roleplay is the first folder under the scenes folder.
	 * @param folderPath Full folder path (e.g., "RP Scenes/For The Greeks/Twin Flames")
	 * @returns Roleplay name (e.g., "For The Greeks") or null if path is invalid
	 */
	extractRoleplayFromPath(folderPath: string): string | null {
		const RP_ROOT = this.settings.scenesFolder;
		if (!folderPath.startsWith(RP_ROOT + "/")) {
			return null;
		}
		
		// Remove RP_ROOT prefix and split
		const relPath = folderPath.slice(RP_ROOT.length + 1);
		const parts = relPath.split("/").filter(p => p.length > 0);
		
		// First part is the Roleplay
		return parts.length > 0 ? parts[0] : null;
	}

	async selectSceneLocation(context?: string): Promise<string | null> {
		/**Select or create scene location folder.
		 * @param context Optional context string (e.g., muse name) to display in the prompt
		 */
		const RP_ROOT = this.settings.scenesFolder;
		const dirSet = new Set<string>();

		// Only scan the configured scenes folder (not vault.getFiles()).
		for (const file of this.getSceneFiles()) {
			const parts = file.path.split("/");
			parts.pop();
			if (parts.length >= 2) {
				for (let i = 2; i <= parts.length; i++) {
					const dirPath = parts.slice(0, i).join("/");
					dirSet.add(dirPath);
				}
			}
		}

		let options = Array.from(dirSet)
			.map((fullPath) => fullPath.slice(RP_ROOT.length + 1))
			.filter(Boolean)
			.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

		// Always add the option to create a new folder path
		options.push("+ New folder path…");

		// Build title with context if provided
		const suggesterTitle = context 
			? `Select location for ${context}`
			: 'Select scene location';
		
		console.log(`[MultimuseObsidian] selectSceneLocation: Showing ${options.length} options with title: ${suggesterTitle}`);
		const choiceIndex = await this.showSuggester(options, options, suggesterTitle);
		if (choiceIndex === null) {
			console.log(`[MultimuseObsidian] selectSceneLocation: User cancelled or no selection`);
			return null;
		}

		const choice = options[choiceIndex];
		if (!choice) return null;

		let relPath: string;
		if (choice === "+ New folder path…") {
			const promptMsg = context
				? `Folder under "${RP_ROOT}" for ${context} (e.g. For the Greeks/Twin Flames)`
				: `Folder under "${RP_ROOT}" (e.g. For the Greeks/Twin Flames)`;
			const input = await this.showInputPrompt(promptMsg);
			if (!input) return null;
			relPath = input.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
		} else {
			relPath = choice;
		}

		return `${RP_ROOT}/${relPath}`;
	}

	/**
	 * Keep wizard keystrokes on the modal so Enter does not reach the markdown editor behind it.
	 */
	isolateWizardModal(modal: Modal, onEnter?: () => void): void {
		modal.shouldRestoreSelection = false;
		modal.modalEl.setAttr('tabindex', '-1');

		modal.scope.register([], 'Enter', (evt) => {
			onEnter?.();
			evt.preventDefault();
			return false;
		});

		const trapEnter = (evt: KeyboardEvent) => {
			if (evt.key === 'Enter') {
				evt.preventDefault();
				evt.stopPropagation();
			}
		};
		modal.modalEl.addEventListener('keydown', trapEnter, { capture: true });
		modal.containerEl.addEventListener('keydown', trapEnter, { capture: true });
	}

	showSuggester<T>(items: string[], _values: T[], title?: string): Promise<number | null> {
		return new Promise((resolve) => {
			const modal = new (class extends Modal {
				selectedIndex: number | null = null;
				items: string[];
				titleText: string;
				host: MultimuseObsidian;

				constructor(app: App, items: string[], titleText: string | undefined, host: MultimuseObsidian) {
					super(app);
					this.items = items;
					this.titleText = titleText || 'Select an option';
					this.host = host;
				}

				onOpen() {
					this.host.isolateWizardModal(this);
					const { contentEl } = this;
					contentEl.empty();
					this.setTitle(this.titleText);
					
					// If title contains context (e.g., "for muse X"), extract and display prominently
					if (this.titleText.includes('for')) {
						// Extract the muse name from the title
						const match = this.titleText.match(/for (.+)$/);
						if (match) {
							const contextInfo = match[1];
							const infoEl = contentEl.createEl('div', {
								cls: 'multimuse-scene-context'
							});
							infoEl.createEl('strong', { 
								text: `Creating scene file for: ${contextInfo}`,
								cls: 'multimuse-scene-context-title'
							});
						}
						contentEl.createEl('p', {
							text: 'Choose where to create the scene file:',
							cls: 'multimuse-scene-location-desc'
						});
					}

					let firstButton: HTMLButtonElement | null = null;
					this.items.forEach((item, index) => {
						const button = contentEl.createEl('button', {
							text: item,
							cls: ['mod-cta', 'multimuse-suggester-button']
						});
						if (!firstButton) {
							firstButton = button;
						}
						button.onclick = () => {
							this.selectedIndex = index;
							this.close();
						};
					});

					window.requestAnimationFrame(() => {
						(firstButton ?? this.modalEl).focus();
					});
				}

				onClose() {
					resolve(this.selectedIndex);
				}
			})(this.app, items, title, this);

			modal.open();
		});
	}

	showInputPrompt(prompt: string, defaultValue?: string): Promise<string | null> {
		return new Promise((resolve) => {
			const modal = new (class extends Modal {
				inputEl!: HTMLInputElement;
				value: string | null = null;
				cancelled = false;
				host: MultimuseObsidian;
				promptText: string;
				defaultText: string;

				constructor(app: App, host: MultimuseObsidian, promptText: string, defaultText?: string) {
					super(app);
					this.host = host;
					this.promptText = promptText;
					this.defaultText = defaultText || '';
				}

				confirm(): void {
					const trimmed = this.inputEl.value.trim();
					this.value = trimmed || null;
					this.close();
				}

				onOpen() {
					this.host.isolateWizardModal(this, () => this.confirm());
					this.setTitle(this.promptText);
					const { contentEl } = this;
					contentEl.empty();

					this.inputEl = contentEl.createEl('input', {
						type: 'text',
						cls: 'multimuse-input',
					});
					this.inputEl.value = this.defaultText;

					new Setting(contentEl)
						.addButton((btn) => btn
							.setButtonText('Continue')
							.setCta()
							.onClick(() => this.confirm()))
						.addButton((btn) => btn
							.setButtonText('Cancel')
							.onClick(() => {
								this.cancelled = true;
								this.close();
							}));

					window.requestAnimationFrame(() => {
						this.inputEl.focus();
						this.inputEl.select();
					});
				}

				onClose() {
					resolve(this.cancelled ? null : this.value);
				}
			})(this.app, this, prompt, defaultValue);

			modal.open();
		});
	}

	/**
	 * Fetch guild members from the bot API using guild_id from the current note's Link property,
	 * then insert a Discord mention <@userId> at the cursor (or replace selection).
	 */
	async insertMentionAtCursor(view: MarkdownView): Promise<void> {
		const file = view.file;
		if (!file) {
			new Notice('No active file.');
			return;
		}
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = this.getFrontmatter(cache);
		if (!frontmatter) {
			new Notice('No frontmatter. Add a Link property (Discord thread URL) to this note.');
			return;
		}
		const link = frontmatter['Link'];
		if (typeof link !== 'string') {
			new Notice('No Link property. Add the Discord thread URL to frontmatter to use @ mentions.');
			return;
		}
		const threadInfo = this.extractThreadInfoFromUrl(link);
		if (!threadInfo?.guildId) {
			new Notice('Link is not a valid Discord channel URL (could not get server ID).');
			return;
		}
		if (!this.settings.apiKey) {
			new Notice('API key required in plugin settings to fetch server members.');
			return;
		}
		let members: GuildMember[];
		try {
			const url = `${this.getBotApiUrl()}/api/v1/guilds/${threadInfo.guildId}/members`;
			const response = await requestUrl({
				url,
				method: 'GET',
				headers: this.getApiHeaders()
			});
			if (response.status !== 200) {
				if (!this.handleApiError(response, 'insertMention - guild members')) {
					new Notice('Could not load server members. Check API and that the bot is in the server.');
				}
				return;
			}
			const data = parseJson<GuildMembersResponse>(response.text);
			members = data.members || [];
		} catch (e) {
			console.error('[MultimuseObsidian] insertMention fetch error:', e);
			new Notice('Failed to fetch server members. Check connection and API key.');
			return;
		}
		if (members.length === 0) {
			new Notice('No members returned for this server. Bot may need Server Members intent.');
			return;
		}
		const sortedMembers = [...members].sort((a, b) => {
			const aName = a.display_name || a.username;
			const bName = b.display_name || b.username;
			return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
		});
		const labels = sortedMembers.map(m => {
			const d = m.display_name || m.username;
			return m.username !== d ? `${d} (@${m.username})` : d;
		});
		const idx = await this.showSuggester(labels, sortedMembers, 'Insert @ mention – choose user');
		if (idx === null || idx < 0) return;
		const chosen = sortedMembers[idx];
		const mention = `<@${chosen.id}>`;
		const editor = view.editor;
		const sel = editor.getSelection();
		if (sel) {
			editor.replaceSelection(mention);
		} else {
			editor.replaceRange(mention, editor.getCursor());
		}
		new Notice(`Inserted @${chosen.display_name || chosen.username}`);
	}

	async sendSelectionAsMuse(editor: Editor, view: MarkdownView): Promise<void> {
		/**Send selected text as a muse to Discord thread from frontmatter properties.*/
		// Get selected text
		const selection = editor.getSelection();
		if (!selection || selection.trim().length === 0) {
			new Notice('No text selected. Please select text to send as muse.');
			return;
		}

		// Get active file
		const file = view.file;
		if (!file) {
			new Notice('No active file found.');
			return;
		}

		// Get frontmatter
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = this.getFrontmatter(cache);
		if (!frontmatter) {
			new Notice('File does not have frontmatter. Please add Link and Characters properties.');
			return;
		}

		// Extract link and characters
		const link = frontmatter?.['Link'];
		if (typeof link !== 'string') {
			new Notice('No Link property found in frontmatter. Please add a Discord thread URL.');
			return;
		}

		const characters = this.getSortedCharacterNames(frontmatter);
		if (characters.length === 0) {
			new Notice('No Characters property found in frontmatter. Please add at least one character name.');
			return;
		}

		// Extract thread ID from link
		const threadId = this.extractThreadIdFromUrl(link);
		if (!threadId) {
			new Notice('Invalid Discord URL format in Link property.');
			return;
		}

		// Select muse if multiple characters
		let selectedMuse: string;
		if (characters.length === 1) {
			selectedMuse = characters[0];
		} else {
			const museIndex = await this.showSuggester(characters, characters);
			if (museIndex === null || museIndex < 0) {
				return;
			}
			selectedMuse = characters[museIndex];
		}

		new Notice(`Sending as ${selectedMuse}…`);

		const primaryUserId = this.settings.cachedUserId || await this.getPrimaryUserId();
		if (!primaryUserId) {
			new Notice('Failed to get user ID from API key. Please check your API key in settings.');
			return;
		}

		const postBody: Record<string, unknown> = {
			thread_id: threadId,
			muse_name: selectedMuse,
			content: selection.trim(),
			user_id: primaryUserId,
		};

		void this.deliverPostAsMuse(selectedMuse, primaryUserId, threadId, postBody, file);
	}

	private async applyMuseWrappersToPost(
		postBody: Record<string, unknown>,
		threadId: string,
		primaryUserId: string,
		matchedMuse: MuseInfo,
		selectedMuse: string
	): Promise<void> {
		const icRaw = typeof postBody.content === 'string' ? postBody.content : '';
		const { header, footer } = await this.resolveMuseWrappers(
			threadId,
			primaryUserId,
			matchedMuse,
			selectedMuse
		);
		if ((header || footer) && canPreapplyWrappers(icRaw, header, footer)) {
			postBody.content = composeChunkForSend(icRaw, header, footer);
			postBody.wrappers_preapplied = true;
		}
	}

	private async deliverPostAsMuse(
		selectedMuse: string,
		primaryUserId: string,
		threadId: string,
		postBody: Record<string, unknown>,
		sceneFile?: TFile
	): Promise<void> {
		try {
			await this.yieldPollSlot();

			let muses = this.museCache.get(primaryUserId) ?? [];
			let matchedMuse = this.findMuseMatch(muses, selectedMuse);
			if (!matchedMuse?.muse_id) {
				muses = await this.getMusesForUserIds([primaryUserId], { forceRefresh: true });
				matchedMuse = this.findMuseMatch(muses, selectedMuse);
			}
			if (matchedMuse?.muse_id) {
				postBody.muse_id = matchedMuse.muse_id;
			}
			if (matchedMuse) {
				await this.applyMuseWrappersToPost(
					postBody,
					threadId,
					primaryUserId,
					matchedMuse,
					selectedMuse
				);
			}

			let response = await this.apiPostJson('/api/v1/messages/post', postBody);

			if (response.status === 403 && !matchedMuse) {
				muses = await this.getMusesForUserIds([primaryUserId], { forceRefresh: true });
				matchedMuse = this.findMuseMatch(muses, selectedMuse);
				if (matchedMuse) {
					if (matchedMuse.muse_id) {
						postBody.muse_id = matchedMuse.muse_id;
					}
					if (!postBody.wrappers_preapplied) {
						await this.applyMuseWrappersToPost(
							postBody,
							threadId,
							primaryUserId,
							matchedMuse,
							selectedMuse
						);
					}
					response = await this.apiPostJson('/api/v1/messages/post', postBody);
				} else if (muses.length > 0) {
					new Notice(`Muse "${selectedMuse}" not found. Available: ${muses.map(m => m.name).join(', ')}`);
					return;
				}
			}

			if (response.status === 200 || response.status === 202) {
				new Notice(`Message sent as ${selectedMuse}!`);
				if (sceneFile) {
					await this.updateFrontmatter(sceneFile, 'Replied?', true);
				}
				void this.syncMuses();
			} else if (!this.handleApiError(response, 'sendSelectionAsMuse - post message')) {
				const errorData = parseJson<ApiErrorBody>(response.text);
				new Notice(`Failed to send message: ${errorData.message || response.status}`);
			}
		} catch (error) {
			console.error('Error sending message:', error);
			new Notice(`Failed to send message: ${getErrorMessage(error)}`);
		}
	}
}

class MultimuseObsidianSettingTab extends PluginSettingTab {
	plugin: MultimuseObsidian;

	constructor(app: App, plugin: MultimuseObsidian) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Polling and Paths')
			.setHeading();

		// Enable/Disable toggle
		new Setting(containerEl)
			.setName('Enable Polling')
			.setDesc('Automatically check Discord threads for new replies')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enabled)
				.onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
					if (value) {
						this.plugin.startPolling();
					} else {
						this.plugin.stopPolling();
					}
				}));

		// Poll Interval
		new Setting(containerEl)
			.setName('Poll Interval (minutes)')
			.setDesc('How often to check for new replies (current value shown beside the slider)')
			.addSlider(slider => slider
				.setLimits(5, 60, 5)
				.setValue(this.plugin.settings.pollInterval)
				.onChange(async (value) => {
					this.plugin.settings.pollInterval = value;
					await this.plugin.saveSettings();
					if (this.plugin.settings.enabled) {
						this.plugin.stopPolling();
						this.plugin.startPolling();
					}
				}));

		// Scenes Folder
		new Setting(containerEl)
			.setName('Scenes Folder')
			.setDesc('Folder containing your scene files')
			.addText(text => text
				.setPlaceholder('RP Scenes')
				.setValue(this.plugin.settings.scenesFolder)
				.onChange(async (value) => {
					this.plugin.settings.scenesFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Obsidian Base Path')
			.setDesc('Path to your Obsidian Base file (e.g., "RP Scenes/Roleplay Tracker.base" or "RP Scenes/Tracker.md"). Leave empty and use **Initialize workspace** below to create `<Scenes Folder>/Roleplay Tracker.base`.')
			.addText(text => text
				.setPlaceholder('RP Scenes/Roleplay Tracker.base')
				.setValue(this.plugin.settings.basePath)
				.onChange(async (value) => {
					this.plugin.settings.basePath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Initialize workspace')
			.setDesc('Create your scenes folder and tracker base from the paths above (or use **Initialize MultiMuse workspace** in the command palette).')
			.addButton(button => button
				.setButtonText('Initialize')
				.setCta()
				.onClick(() => {
					void this.plugin.initializeMultimuseWorkspace();
				}));

		// Scene Properties Tracking
		new Setting(containerEl)
			.setName('Scene Properties')
			.setHeading();

		new Setting(containerEl)
			.setName('Track Roleplay Property')
			.setDesc(`Automatically add "Roleplay" property to scene files based on the selected folder (e.g., "For The Greeks" from "${this.plugin.settings.scenesFolder}/For The Greeks/Twin Flames")`)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.trackRoleplay)
				.onChange(async (value) => {
					this.plugin.settings.trackRoleplay = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Track Is Active? Property')
			.setDesc('Automatically add "Is Active?" property to new scene files (defaults to true)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.trackIsActive)
				.onChange(async (value) => {
					this.plugin.settings.trackIsActive = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Obsidian as source of truth')
			.setDesc('When enabled, edits to Characters and Participants in scene frontmatter are pushed to MultiMuse using the thread id from Link. Use this when you adjust muses or participant counts in Obsidian instead of Discord.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.obsidianSourceOfTruth)
				.onChange(async (value) => {
					this.plugin.settings.obsidianSourceOfTruth = value;
					this.plugin.sceneMetadataSyncCache.clear();
					await this.plugin.saveSettings();
				}));

		// Bot API URL - Hidden from user for security (uses hardcoded default)
		// Removed from settings UI to prevent exposing server IP address

		// API Key (required for authentication)
		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Your Multimuse API key for authentication. Generate one using /api generate in Discord DMs with the bot. Your user ID will be automatically detected from the API key.')
			.addText(text => {
				text.setPlaceholder('mm_...')
					.setValue(this.plugin.settings.apiKey || '')
					.inputEl.type = 'password';
				text.onChange(async (value) => {
					this.plugin.settings.apiKey = value.trim();
					// Clear cached user ID when API key changes
					this.plugin.settings.cachedUserId = '';
					await this.plugin.saveSettings();
					
					// Auto-fetch user ID from API key
					if (value.trim()) {
						const userId = await this.plugin.getUserIdFromApiKey();
						if (userId) {
							new Notice(`User ID detected: ${userId}`);
							await this.plugin.syncMuses();
							if (this.plugin.settings.enabled) {
								this.plugin.stopPolling();
								this.plugin.startPolling();
							}
						} else {
							new Notice('Failed to get user ID from API key. Please check your API key.');
						}
					}
				});
			});

		// Show cached user ID (read-only, for information)
		if (this.plugin.settings.cachedUserId) {
			new Setting(containerEl)
				.setName('Detected User ID')
				.setDesc(`Your Discord user ID (automatically detected from API key): ${this.plugin.settings.cachedUserId}`)
				.addText(text => {
					text.setValue(this.plugin.settings.cachedUserId);
					text.inputEl.disabled = true;
				});
		}

		// Sync Muses button
		new Setting(containerEl)
			.setName('Sync Muses')
			.setDesc('Manually sync muse names from bot API')
			.addButton(button => button
				.setButtonText('Sync Now')
				.setCta()
				.onClick(async () => {
					await this.plugin.syncMuses();
					new Notice('Muses synced!');
				}));

		// Manual check button
		new Setting(containerEl)
			.setName('Manual Check')
			.setDesc('Check Discord threads now')
			.addButton(button => button
				.setButtonText('Check Now')
				.setCta()
				.onClick(() => {
					void this.plugin.checkAllThreads({ force: true });
					new Notice('Checking Discord threads...');
				}));

		// Info section
		containerEl.createEl('hr');
		const infoEl = containerEl.createEl('div');
		new Setting(infoEl)
			.setName('How It Works')
			.setHeading();
		infoEl.createEl('p', { text: 'This plugin queries the Multimuse API to check if your scene files match tracked threads and updates the "Replied?" field.' });
		infoEl.createEl('p', { text: '• Scenes are matched by Link (thread id) and Characters properties' });
		infoEl.createEl('p', { text: '• Use **Check Discord Threads Now** (or polling) to refresh Replied? — true = you replied, false = your turn' });
		infoEl.createEl('p', { text: '• Enable **Obsidian as source of truth** to push Characters and Participants changes from frontmatter to the tracker' });
		infoEl.createEl('p', { text: '• Make sure your scene files have a "Link" field (Discord thread URL) and "Characters" field (array) in frontmatter' });
		infoEl.createEl('p', { text: '• Uses Multimuse API - requires an API key for authentication' });
		infoEl.createEl('p', { text: '• Generate an API key using /api generate in Discord DMs with the bot' });
		infoEl.createEl('p', { text: '• Scenes are auto-detected when queried - no manual registration needed' });
	}
}

