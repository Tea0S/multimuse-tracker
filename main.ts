import { Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder, TAbstractFile, App, requestUrl, Modal, Editor, MarkdownView, CachedMetadata, RequestUrlResponse } from 'obsidian';

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
	trackIsActive: true // Default: add Is Active? property
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

function getErrorStatus(error: unknown): number | undefined {
	if (error && typeof error === 'object') {
		const details = error as { status?: unknown };
		if (typeof details.status === 'number') return details.status;
	}
	return undefined;
}

export default class MultimuseObsidian extends Plugin {
	settings: MultimuseObsidianSettings;
	pollIntervalId: number | null = null;
	museCache: Map<string, MuseInfo[]> = new Map(); // user_id (as string) -> muses
	recentlyCreatedFiles: Set<string> = new Set(); // Track recently created files to skip immediate checking
	// Cache of last-seen "Is Active?" value per scene path so we only sync when the user actually toggles it.
	// This prevents Obsidian from resurrecting scenes that StageHand or the bot have already ended/removed.
	sceneActiveCache: Map<string, boolean> = new Map();

	async onload() {
		await this.loadSettings();

		// Add settings tab
		this.addSettingTab(new MultimuseObsidianSettingTab(this.app, this));

		// Sync muses on startup (auto-fetch user ID from API key)
		if (this.settings.apiKey) {
			await this.getUserIdFromApiKey(); // Cache user ID
			await this.syncMuses();
		}

		// Start polling if enabled
		if (this.settings.enabled && this.settings.apiKey) {
			this.startPolling();
		}

		// Add command to manually check now
		this.addCommand({
			id: 'check-discord-threads',
			name: 'Check Discord Threads Now',
			callback: () => {
				void this.checkAllThreads();
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

		// Add command to create new scene
		this.addCommand({
			id: 'create-scene',
			name: 'Create New Scene',
			callback: () => {
				void this.createNewScene();
			}
		});

		// Add command to sync from tracker
		this.addCommand({
			id: 'sync-from-tracker',
			name: 'Sync from Tracker',
			callback: () => {
				void this.syncFromTracker();
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
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

	startPolling() {
		this.stopPolling(); // Clear any existing interval
		
		if (!this.settings.ownerId) {
			new Notice('Discord user ID not configured. Please set it in settings.');
			return;
		}

		const intervalMs = this.settings.pollInterval * 60 * 1000;
		this.pollIntervalId = window.setInterval(() => {
			void this.checkAllThreads();
		}, intervalMs);

		// Do an initial check
		void this.checkAllThreads();
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

	async trackThread(params: {
		threadId: string;
		userId: string;
		museName: string;
		participants: number;
		scenePath?: string;
		guildId?: string | null;
		characters?: string[];
	}): Promise<RequestUrlResponse> {
		const body: Record<string, unknown> = {
			thread_id: params.threadId,
			user_id: params.userId,
			muse_name: params.museName,
			participants: params.participants
		};
		if (params.scenePath) body.scene_path = params.scenePath;
		if (params.guildId) body.guild_id = params.guildId;
		if (params.characters && params.characters.length > 0) body.characters = params.characters;

		return await requestUrl({
			url: `${this.getBotApiUrl()}/api/v1/threads/track`,
			method: 'POST',
			headers: this.getApiHeaders(),
			body: JSON.stringify(body)
		});
	}

	getFrontmatter(cache: CachedMetadata | null): FrontmatterData | null {
		if (!cache?.frontmatter) {
			return null;
		}
		return cache.frontmatter as FrontmatterData;
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

	async syncMuses(): Promise<void> {
		/**Sync muse names from bot API for all configured user IDs.*/
		if (!this.settings.apiKey) {
			return;
		}

		try {
			// Collect all user IDs (deduplicated) - now from API key
			const userIds = await this.getAllUserIds();
			if (userIds.length === 0) {
				return;
			}

			// Build query string - always use user_ids parameter for consistency
			const queryParam = `user_ids=${userIds.join(',')}`;

			const url = `${this.getBotApiUrl()}/api/v1/muses/list?${queryParam}`;

			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: this.getApiHeaders()
			});

			if (response.status === 200) {
				const data = parseJson<MusesListResponse>(response.text);
				const muses: MuseInfo[] = data.muses || [];
				
				// Cache all muses for each user ID (API already returns all accessible muses for all provided user IDs)
				// Since the API returns muses that are either owned by or shared with any of the user IDs,
				// we cache all of them for each user ID so they're available when needed
				// Keep user IDs as strings to avoid precision loss with large Discord IDs
				for (const userId of userIds) {
					this.museCache.set(String(userId), muses);
				}
				
				console.log(`[MultimuseObsidian] Synced ${muses.length} muse(s) for ${userIds.length} user(s)`);
			} else {
				if (!this.handleApiError(response, 'syncMuses')) {
					console.error(`Failed to sync muses: ${response.status} - ${response.text}`);
				}
			}
		} catch (error) {
			console.error('Error syncing muses:', error);
		}
	}

	async checkAllThreads() {
		if (!this.settings.enabled || !this.settings.apiKey) {
			return;
		}

		await this.checkAllThreadsViaBotApi();
	}

	async checkAllThreadsViaBotApi(): Promise<void> {
		/**Check all scene files against current thread_tracking state.*/
		if (!this.settings.apiKey) {
			return;
		}

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
			const trackedResponse = await requestUrl({
				url: trackedUrl,
				method: 'GET',
				headers: this.getApiHeaders()
			});

			if (trackedResponse.status !== 200) {
				if (!this.handleApiError(trackedResponse, 'checkAllThreadsViaBotApi')) {
					console.error(`[MultimuseObsidian] Failed to fetch tracked threads: ${trackedResponse.status} - ${trackedResponse.text}`);
				}
				return;
			}

			const trackedData = parseJson<TrackedThreadsResponse>(trackedResponse.text);
			const trackedThreads = trackedData.threads || [];

			if (trackedThreads.length === 0) {
				return;
			}

			// Create a map of scene_path -> thread info for quick lookup.
			const scenePathMap = new Map<string, TrackedThread>();
			for (const thread of trackedThreads) {
				if (thread.scene_path) {
					scenePathMap.set(thread.scene_path, thread);
				}
				for (const scenePath of thread.scene_paths || []) {
					scenePathMap.set(scenePath, thread);
				}
			}

			// Get all scene files
			const sceneFiles = this.getSceneFiles();
			let updatedCount = 0;

			// Process each scene file
			for (const file of sceneFiles) {
				try {
					// Skip checking if this file was recently created by the plugin
					if (this.recentlyCreatedFiles.has(file.path)) {
						console.log(`[MultimuseObsidian] checkAllThreadsViaBotApi: Skipping recently created file: ${file.path}`);
						continue;
					}

					const cache = this.app.metadataCache.getFileCache(file);
					const frontmatter = this.getFrontmatter(cache);
					if (!frontmatter) {
						continue;
					}

					// Skip if scene is marked as inactive
					const isActive = frontmatter['Is Active?'];
					if (isActive === false || isActive === 'false') {
						continue;
					}

					// Check if this scene is in the linked threads
					const threadInfo = scenePathMap.get(file.path);
					if (!threadInfo) {
						// Scene not linked in thread_tracking, try querying by thread_id and characters.
						const link = frontmatter['Link'];
						if (typeof link !== 'string') continue;

						const characters = this.getCharacterNames(frontmatter);
						if (characters.length === 0) continue;

						const threadId = this.extractThreadIdFromUrl(link);
						if (!threadId) continue;

						// Query this scene individually
						const updated = await this.querySceneState(file);
						if (updated) {
							updatedCount++;
						}
					} else {
						// Scene is linked - query its state
						const characters = this.getCharacterNames(frontmatter);
						if (characters.length === 0) continue;

						const charactersParam = characters.join(',');
						// Use primary user ID for query
						const primaryUserId = await this.getPrimaryUserId();
						if (!primaryUserId) {
							continue;
						}
						const queryUrl = `${this.getBotApiUrl()}/api/v1/scenes/query?thread_id=${threadInfo.thread_id}&characters=${encodeURIComponent(charactersParam)}&user_id=${primaryUserId}`;

						const queryResponse = await requestUrl({
							url: queryUrl,
							method: 'GET',
							headers: this.getApiHeaders()
						});

						if (queryResponse.status === 200) {
							const queryData = parseJson<SceneQueryResponse>(queryResponse.text);
							
							if (queryData.tracked && queryData.state) {
								const state = queryData.state;
								const updated = await this.updateSceneFromState(file, cache, state);
								if (updated) {
									updatedCount++;
								}
							}
						} else {
							// Log auth errors but don't spam for every scene
							if (queryResponse.status === 401) {
								this.handleApiError(queryResponse, 'checkAllThreadsViaBotApi - query scene');
							}
						}
					}
				} catch (error) {
					console.error(`Error checking ${file.path}:`, error);
				}
			}

			if (updatedCount > 0) {
				new Notice(`Updated ${updatedCount} scene file(s)`);
			}
		} catch (error) {
			console.error(`[MultimuseObsidian] Error checking all threads:`, error);
		}
	}

	async querySceneState(file: TFile): Promise<boolean> {
		/**Query the tracker API for a specific scene's state and update frontmatter.*/
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

		// Skip if scene is marked as inactive
		const isActive = frontmatter['Is Active?'];
		if (isActive === false || isActive === 'false') {
			return false; // Skip inactive scenes
		}

		const link = frontmatter['Link'];
		if (typeof link !== 'string') {
			return false;
		}

		const characters = this.getCharacterNames(frontmatter);
		if (characters.length === 0) {
			return false;
		}

		const threadId = this.extractThreadIdFromUrl(link);
		if (!threadId) {
			return false;
		}

		try {
			// Query the tracker API for this specific scene
			const charactersParam = characters.join(',');
			// Use primary user ID for query
			const primaryUserId = await this.getPrimaryUserId();
			if (!primaryUserId) {
				return false;
			}
			const url = `${this.getBotApiUrl()}/api/v1/scenes/query?thread_id=${threadId}&characters=${encodeURIComponent(charactersParam)}&user_id=${primaryUserId}`;

			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: this.getApiHeaders()
			});

			if (response.status !== 200) {
				if (!this.handleApiError(response, `querySceneState for ${file.path}`)) {
					console.error(`[MultimuseObsidian] API error for ${file.path}: ${response.status} - ${response.text}`);
				}
				return false;
			}

			const data = parseJson<SceneQueryResponse>(response.text);
			
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
			console.log(`[MultimuseObsidian] ${file.basename}: state.replied/is_from_character is undefined/null - skipping update`);
			return false;
		}

		// Check if the state looks suspicious (e.g., bot couldn't access channel)
		// If timestamp is null and your_last_post is null, it might indicate the bot couldn't read the channel
		// In this case, don't update the Replied? field to avoid incorrect updates
		if (state.timestamp === null && state.your_last_post === null && state.posted_since_count === 0) {
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
		/**Handle scene file creation/modification - scenes are auto-detected when queried, no registration needed.*/
		// Only process files in the scenes folder
		if (!file.path.startsWith(this.settings.scenesFolder + '/')) {
			return;
		}

		// Only process if enabled and API key is set
		if (!this.settings.apiKey || !this.settings.enabled) {
			return;
		}

		// Skip checking if this file was recently created by the plugin
		if (this.recentlyCreatedFiles.has(file.path)) {
			console.log(`[MultimuseObsidian] Skipping check for recently created file: ${file.path}`);
			return;
		}

		// Small delay to avoid checking during file creation
		await new Promise(resolve => window.setTimeout(resolve, 1000));

		const cache = this.app.metadataCache.getFileCache(file);
		if (this.getFrontmatter(cache)) {
			// Sync Is Active? to the tracker so unchecking removes the scene from MultiMuse
			await this.syncSceneActiveStatusToApi(file, cache);
			// Sync Participants to the tracker so "your turn" / Replied? use the correct count
			await this.syncSceneParticipantsToApi(file, cache);
		}

		// Query the scene state - this will auto-detect if it matches a tracked thread
		try {
			await this.querySceneState(file);
		} catch (error) {
			// Silently fail - don't spam errors for every file change
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
					console.log(`[MultimuseObsidian] Synced Is Active?=false for ${file.path} - removed from tracker`);
				}
			}
		} catch (e) {
			console.debug(`[MultimuseObsidian] Could not sync Is Active? for ${file.path}:`, e);
		}
	}

	/**
	 * Sync the scene's "Participants" frontmatter to the MultiMuse API.
	 * So the bot's "your turn" / Replied? logic uses the correct participant count.
	 */
	async syncSceneParticipantsToApi(file: TFile, cache: { frontmatter?: Record<string, unknown> }): Promise<void> {
		const link = cache.frontmatter?.['Link'];
		if (!link) return;

		const primaryUserId = await this.getPrimaryUserId();
		if (!primaryUserId) return;

		if (typeof link !== 'string') return;

		const threadId = this.extractThreadIdFromUrl(link);
		const raw = cache.frontmatter?.['Participants'];
		const participants = typeof raw === 'number' && raw >= 1
			? raw
			: typeof raw === 'string'
				? parseInt(raw, 10)
				: 2;
		if (isNaN(participants) || participants < 1) return;

		try {
			const body: Record<string, unknown> = {
				scene_path: file.path,
				user_id: primaryUserId,
				participants: participants
			};
			if (threadId) body.thread_id = threadId;

			const response = await requestUrl({
				url: `${this.getBotApiUrl()}/api/v1/scenes/update-participants`,
				method: 'POST',
				headers: { ...this.getApiHeaders(), 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (response.status === 200) {
				console.debug(`[MultimuseObsidian] Synced Participants=${participants} for ${file.path}`);
			}
		} catch (e) {
			console.debug(`[MultimuseObsidian] Could not sync Participants for ${file.path}:`, e);
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

	/** Build a map of thread_id (from Link property) -> TFile for all scene files that have a valid Link. */
	getExistingSceneLinksByThreadId(): Map<string, TFile> {
		const map = new Map<string, TFile>();
		for (const file of this.getSceneFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			const link = cache?.frontmatter?.['Link'];
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
			return characters.map(c => String(c).trim());
		} else if (typeof characters === 'string') {
			// Handle comma-separated string
			return characters.split(',').map(c => c.trim()).filter(c => c.length > 0);
		}

		return [String(characters).trim()];
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
		if (!this.settings.apiKey) {
			new Notice('API key must be configured in settings.');
			return;
		}

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

		// 2) Select muse
		const museOptions = muses.map(m => m.name);
		const selectedMuseIndex = await this.showSuggester(museOptions, museOptions, 'Select a muse');
		if (selectedMuseIndex === null || selectedMuseIndex < 0) return;

		const selectedMuse = muses[selectedMuseIndex];

		// Small delay to ensure previous modal is fully closed
		await new Promise(resolve => window.setTimeout(resolve, 100));

		// 3) Get Discord thread/channel link
		const threadUrl = await this.showInputPrompt('Enter Discord thread/channel URL');
		if (!threadUrl) return;

		const threadInfo = this.extractThreadInfoFromUrl(threadUrl);
		if (!threadInfo) {
			new Notice('Invalid Discord URL format.');
			return;
		}

		// Small delay before opening location modal
		await new Promise(resolve => window.setTimeout(resolve, 100));

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

		const frontmatterLines = ['---'];
		for (const [key, value] of Object.entries(frontmatter)) {
			if (Array.isArray(value)) {
				frontmatterLines.push(`${key}:`);
				for (const item of value) {
					frontmatterLines.push(`  - ${item}`);
				}
			} else {
				frontmatterLines.push(`${key}: ${value}`);
			}
		}
		frontmatterLines.push('---');
		frontmatterLines.push('');

		const content = frontmatterLines.join('\n');

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
			
			const registerResponse = await this.trackThread({
				threadId: threadInfo.threadId,
				userId: primaryUserId,
				museName: selectedMuse.name,
				participants: participants,
				scenePath: createdFile.path,
				guildId: threadInfo.guildId || null,
				characters: [selectedMuse.name]
			});
			
			console.debug(`Thread tracking response: ${registerResponse.status} - ${registerResponse.text}`);

			if (registerResponse.status === 200) {
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

	async syncFromTracker(): Promise<void> {
		/**Sync scenes from bot tracker to Obsidian Base and create missing scene files.*/
		if (!this.settings.apiKey) {
			new Notice('API key must be configured in settings.');
			return;
		}

		try {
			// Get primary user ID for tracked threads query
			const primaryUserId = await this.getPrimaryUserId();
			if (!primaryUserId) {
				new Notice('Failed to get user ID from API key. Please check your API key in settings.');
				return;
			}

			// Get tracked threads from bot
			const response = await requestUrl({
				url: `${this.getBotApiUrl()}/api/v1/threads/tracked?user_id=${primaryUserId}`,
				method: 'GET',
				headers: this.getApiHeaders()
			});

			if (response.status !== 200) {
				if (!this.handleApiError(response, 'syncFromTracker - fetch tracked threads')) {
					console.error(`Failed to fetch tracked threads: ${response.status}`);
					new Notice('Failed to fetch tracked threads from bot.');
				}
				return;
			}

			const data = parseJson<TrackedThreadsResponse>(response.text);
			const threads = data.threads || [];

			if (threads.length === 0) {
				new Notice('No tracked threads found.');
				return;
			}

			// Cross-check: which thread IDs already have a scene in Obsidian (via Link property)?
			const existingLinksByThreadId = this.getExistingSceneLinksByThreadId();

			let createdCount = 0;
			let updatedCount = 0;

			for (const thread of threads) {
				const threadId = String(thread.thread_id ?? '');
				const museName = thread.muse_name || 'Muse';
				const participants = thread.participants || 2;
				const existingScenePath = thread.scene_path;

				// 1) Scene already exists at the path the tracker knows about
				if (existingScenePath) {
					const existingFile = this.app.vault.getAbstractFileByPath(existingScenePath);
					if (existingFile && existingFile instanceof TFile) {
						if (this.settings.basePath) {
							await this.updateBaseRecord(existingFile, thread);
						}
						updatedCount++;
						continue;
					}
				}

				// 2) No scene_path from tracker, but an Obsidian note already has this thread in its Link
				const existingFileByLink = existingLinksByThreadId.get(threadId);
				if (existingFileByLink) {
					if (this.settings.basePath) {
						await this.updateBaseRecord(existingFileByLink, thread);
					}
					updatedCount++;
					continue;
				}

				// 3) Create new scene only when we have a scene_path from tracker and no existing note for this thread
				// (If no scene_path, this thread isn't linked to Obsidian from the bot's side)
				if (!existingScenePath) {
					continue;
				}
				
				const guildId = thread.guild_id;
				// Don't create URLs with guild_id=0 - that's invalid
				const threadUrl = guildId && guildId !== '0' && guildId !== 0
					? `https://discord.com/channels/${guildId}/${threadId}`
					: null;  // Can't create valid URL without guild_id
				
				if (!threadUrl) {
					console.debug(`Skipping thread ${threadId} - no valid guild_id`);
					continue;
				}

				// Determine location (use scenes folder + default subfolder or prompt)
				const location = await this.selectSceneLocation(`muse "${museName}"`);
				if (!location) continue;

				const sceneName = thread.thread_name || `${museName} - Thread ${threadId}`;
				const filePath = `${location}/${sceneName}.md`;

				const frontmatter: Record<string, FrontmatterValue> = {
					'Link': threadUrl,
					'Characters': [museName],
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

				const frontmatterLines = ['---'];
				for (const [key, value] of Object.entries(frontmatter)) {
					if (Array.isArray(value)) {
						frontmatterLines.push(`${key}:`);
						for (const item of value) {
							frontmatterLines.push(`  - ${item}`);
						}
					} else {
						frontmatterLines.push(`${key}: ${value}`);
					}
				}
				frontmatterLines.push('---');
				frontmatterLines.push('');

				const content = frontmatterLines.join('\n');

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
				const file = await this.app.vault.create(filePath, content);
				
				// Mark this file as recently created to skip immediate checking
				this.recentlyCreatedFiles.add(filePath);
				// Remove from the set after 30 seconds (enough time for the scene to be registered with the API)
				window.setTimeout(() => {
					this.recentlyCreatedFiles.delete(filePath);
				}, 30000);

				// Link the created note back to the current Discord-side thread tracker.
				const primaryUserId = await this.getPrimaryUserId();
				if (!primaryUserId) {
					console.error('Failed to get user ID from API key, skipping thread tracking update');
					continue;
				}
				
				await this.trackThread({
					threadId: threadId,
					userId: primaryUserId,
					museName: museName,
					participants: Number(participants) || 2,
					scenePath: filePath,
					guildId: guildId ? String(guildId) : null,
					characters: [museName]
				});

				// Add to Base if configured
				if (this.settings.basePath) {
					await this.addSceneToBase(file, frontmatter);
				}

				createdCount++;
			}

			new Notice(`Sync complete: ${createdCount} created, ${updatedCount} updated`);
		} catch (error) {
			console.error('Error syncing from tracker:', error);
			new Notice('Error syncing from tracker. Check console for details.');
		}
	}

	// ========= BASE INTEGRATION =========

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
			const link = frontmatter['Link'] || '';
			const participants = frontmatter['Participants'] || 2;
			const replied = frontmatter['Replied?'] || false;

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

	async updateBaseRecord(file: TFile, thread: TrackedThread): Promise<void> {
		/**Update existing Base record for a scene.*/
		if (!this.settings.basePath) return;

		try {
			const baseFile = this.app.vault.getAbstractFileByPath(this.settings.basePath);
			if (!baseFile || !(baseFile instanceof TFile)) return;

			// Skip .base files - they use a special format
			if (baseFile.extension === 'base') {
				return;
			}

			// Only handle .md files
			if (baseFile.extension !== 'md') {
				return;
			}

			const baseContent = await this.app.vault.read(baseFile);
			const sceneName = file.basename;

			// Update the row for this scene
			const lines = baseContent.split('\n');
			const updatedLines = lines.map(line => {
				if (line.includes(`| ${sceneName} |`)) {
					const characters = [thread.muse_name || 'Muse'];
					const link = thread.guild_id && thread.guild_id !== '0'
						? `https://discord.com/channels/${thread.guild_id}/${thread.thread_id}`
						: `https://discord.com/channels/0/${thread.thread_id}`;
					return `| ${sceneName} | ${characters.join(', ')} | ${link} | ${thread.participants || 2} | false |`;
				}
				return line;
			});

			await this.app.vault.modify(baseFile, updatedLines.join('\n'));
		} catch (error) {
			console.error('Error updating Base record:', error);
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
		const files = this.app.vault.getFiles();
		const dirSet = new Set<string>();

		for (const file of files) {
			if (!file.path.startsWith(RP_ROOT + "/")) continue;
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

	showSuggester<T>(items: string[], _values: T[], title?: string): Promise<number | null> {
		return new Promise((resolve) => {
			// Create a modal with buttons
			const modal = new (class extends Modal {
				selectedIndex: number | null = null;
				items: string[];
				titleText: string;

				constructor(app: App, items: string[], titleText?: string) {
					super(app);
					this.items = items;
					this.titleText = titleText || 'Select an option';
					// Set title in constructor to ensure it's set before modal opens
					this.titleEl.textContent = this.titleText;
				}

				onOpen() {
					const { contentEl } = this;
					contentEl.empty();
					
					// Ensure title is set (in case it was reset)
					this.titleEl.textContent = this.titleText;
					
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

					this.items.forEach((item, index) => {
						const button = contentEl.createEl('button', {
							text: item,
							cls: ['mod-cta', 'multimuse-suggester-button']
						});
						button.onclick = () => {
							this.selectedIndex = index;
							this.close();
						};
					});
				}

				onClose() {
					resolve(this.selectedIndex);
				}
			})(this.app, items, title);

			console.log(`[MultimuseObsidian] showSuggester: Opening modal with ${items.length} items, title: ${title || 'Select an option'}`);
			// Use requestAnimationFrame to ensure modal opens after any previous modals are fully closed
			window.requestAnimationFrame(() => {
				modal.open();
			});
		});
	}

	showInputPrompt(prompt: string, defaultValue?: string): Promise<string | null> {
		return new Promise((resolve) => {
			// Use Obsidian's built-in modal for input
			const modal = new (class extends Modal {
				inputEl: HTMLInputElement;
				value: string | null = null;

				constructor(app: App, prompt: string, defaultValue?: string) {
					super(app);
					this.titleEl.textContent = prompt;
					this.inputEl = this.contentEl.createEl('input', {
						type: 'text',
						value: defaultValue || '',
						cls: 'multimuse-input'
					});
					this.inputEl.onkeydown = (e) => {
						if (e.key === 'Enter') {
							this.value = this.inputEl.value;
							this.close();
						}
					};
				}

				onOpen() {
					this.inputEl.focus();
					this.inputEl.select();
				}

				onClose() {
					resolve(this.value);
				}
			})(this.app, prompt, defaultValue);

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
		if (!cache?.frontmatter) {
			new Notice('No frontmatter. Add a Link property (Discord thread URL) to this note.');
			return;
		}
		const frontmatter = this.getFrontmatter(cache);
		const link = frontmatter?.['Link'];
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
		const labels = members.map(m => {
			const d = m.display_name || m.username;
			return m.username !== d ? `${d} (@${m.username})` : d;
		});
		const idx = await this.showSuggester(labels, members, 'Insert @ mention – choose user');
		if (idx === null || idx < 0) return;
		const chosen = members[idx];
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

		const characters = this.getCharacterNames(frontmatter);
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

		// Get primary user ID
		const primaryUserId = await this.getPrimaryUserId();
		if (!primaryUserId) {
			new Notice('Failed to get user ID from API key. Please check your API key in settings.');
			return;
		}

		// Select muse if multiple characters
		let selectedMuse: string;
		if (characters.length === 1) {
			selectedMuse = characters[0];
		} else {
			// Show modal to select muse
			const museIndex = await this.showSuggester(characters, characters);
			if (museIndex === null || museIndex < 0) {
				return; // User cancelled
			}
			selectedMuse = characters[museIndex];
		}

		// Verify muse exists and is accessible
		const userIds = await this.getAllUserIds();
		if (userIds.length === 0) {
			new Notice('Failed to get user ID from API key. Please check your API key in settings.');
			return;
		}

		// Get muses to verify the selected muse is available
		let muses: MuseInfo[] = [];
		try {
			const queryParam = `user_ids=${userIds.join(',')}`;
			const url = `${this.getBotApiUrl()}/api/v1/muses/list?${queryParam}`;
			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: this.getApiHeaders()
			});

			if (response.status === 200) {
				const data = parseJson<MusesListResponse>(response.text);
				muses = data.muses || [];
			} else {
				if (!this.handleApiError(response, 'sendSelectionAsMuse - fetch muses')) {
					new Notice(`Failed to fetch muses: ${response.status}`);
				}
				return;
			}
		} catch (error) {
			console.error('Error fetching muses:', error);
			new Notice('Failed to fetch muses from bot API. Check your API URL and connection.');
			return;
		}

		// Find matching muse (case-insensitive fuzzy) for validation and optional muse_id
		const matchedMuse = muses.find(m => {
			const museLower = m.name.toLowerCase().trim();
			const selectedLower = selectedMuse.toLowerCase().trim();
			return museLower === selectedLower || museLower.includes(selectedLower) || selectedLower.includes(museLower);
		});

		if (!matchedMuse) {
			new Notice(`Muse "${selectedMuse}" not found or not accessible. Available muses: ${muses.map(m => m.name).join(', ')}`);
			return;
		}

		// Build post body: use muse_id when available (alias-safe), keep muse_name for display/fallback
		const postBody: Record<string, unknown> = {
			thread_id: threadId,
			muse_name: selectedMuse,
			content: selection.trim(),
			user_id: primaryUserId
		};
		if (matchedMuse.muse_id) {
			postBody.muse_id = matchedMuse.muse_id;
		}

		// Post message via API
		try {
			const url = `${this.getBotApiUrl()}/api/v1/messages/post`;
			const response = await requestUrl({
				url: url,
				method: 'POST',
				headers: this.getApiHeaders(),
				body: JSON.stringify(postBody)
			});

			if (response.status === 200) {
				new Notice(`Message sent as ${selectedMuse}!`);
			} else {
				if (!this.handleApiError(response, 'sendSelectionAsMuse - post message')) {
					const errorData = parseJson<ApiErrorBody>(response.text);
					new Notice(`Failed to send message: ${errorData.message || response.status}`);
				}
			}
		} catch (error) {
			console.error('Error sending message:', error);
			const errorMessage = getErrorMessage(error);
			new Notice(`Failed to send message: ${errorMessage}`);
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
			.setName('Multimuse Settings')
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
			.setDesc('How often to check for new replies')
			.addSlider(slider => slider
				.setLimits(5, 60, 5)
				.setValue(this.plugin.settings.pollInterval)
				.setDynamicTooltip()
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
			.setDesc('Path to your Obsidian Base file (e.g., "RP Scenes/Roleplay Tracker.base" or "RP Scenes/Tracker.md")')
			.addText(text => text
				.setPlaceholder('RP Scenes/Roleplay Tracker.base')
				.setValue(this.plugin.settings.basePath)
				.onChange(async (value) => {
					this.plugin.settings.basePath = value;
					await this.plugin.saveSettings();
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
					void this.plugin.checkAllThreads();
					new Notice('Checking Discord threads...');
				}));

		// Info section
		containerEl.createEl('hr');
		const infoEl = containerEl.createEl('div');
		new Setting(infoEl)
			.setName('How It Works')
			.setHeading();
		infoEl.createEl('p', { text: 'This plugin queries the Multimuse API to check if your scene files match tracked threads and updates the "Replied?" and "Participants" fields.' });
		infoEl.createEl('p', { text: '• Scenes are matched by Link (thread_id) and Characters properties' });
		infoEl.createEl('p', { text: '• If scene matches a tracked thread: Updates Replied? only (true = you replied, false = need to reply). Participants is always editable in frontmatter.' });
		infoEl.createEl('p', { text: '• If scene does not match: No updates (scene is not tracked)' });
		infoEl.createEl('p', { text: '• Make sure your scene files have a "Link" field (Discord thread URL) and "Characters" field (array) in frontmatter' });
		infoEl.createEl('p', { text: '• Uses Multimuse API - requires an API key for authentication' });
		infoEl.createEl('p', { text: '• Generate an API key using /api generate in Discord DMs with the bot' });
		infoEl.createEl('p', { text: '• Scenes are auto-detected when queried - no manual registration needed' });
	}
}

