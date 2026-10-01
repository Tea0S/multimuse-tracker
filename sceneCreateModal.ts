import { App, Modal, normalizePath } from 'obsidian';

const NEW_CHOICE = '__new__';

export interface CreateSceneDraft<T> {
	muse: T;
	threadUrl: string;
	location: string;
	sceneName: string;
	participants: number;
}

export interface CreateSceneModalOptions<T> {
	app: App;
	scenesFolder: string;
	muses: Array<{ value: T; label: string }>;
	roleplays: string[];
	/** Extra path under the roleplay when the user leaves Folder on "This folder". */
	layoutFolder: (roleplay: string, muse: T | null) => string;
	listSubfolders: (roleplay: string) => string[];
	roleplayForGuild: (guildId: string) => { roleplay: string; subfolder: string } | null;
	parseThreadUrl: (url: string) => { guildId: string | null } | null;
	trapKeys: (modal: Modal, onEnter: () => void) => void;
}

export function openCreateSceneModal<T>(opts: CreateSceneModalOptions<T>): Promise<CreateSceneDraft<T> | null> {
	return new Promise((resolve) => {
		const modal = new CreateSceneModal(opts, resolve);
		modal.open();
	});
}

class CreateSceneModal<T> extends Modal {
	private readonly opts: CreateSceneModalOptions<T>;
	private readonly finish: (draft: CreateSceneDraft<T> | null) => void;
	private settled = false;
	private sceneName = '';
	private threadUrl = '';
	private participants = '2';
	private selectedRoleplay = '';
	private newRoleplay = '';
	private selectedFolder = '';
	private newFolder = '';
	private folderQuery = '';
	private museQuery = '';
	private selectedMuse = 0;
	private lastAutoGuild = '';
	private extraRoleplays: string[] = [];
	private nameInput!: HTMLInputElement;
	private linkHint!: HTMLElement;
	private roleplayHost!: HTMLElement;
	private newRoleplayHost!: HTMLElement;
	private folderHost!: HTMLElement;
	private folderSearchHost!: HTMLElement;
	private folderExtraHost!: HTMLElement;
	private museHost!: HTMLElement;
	private submitBtn!: HTMLButtonElement;

	constructor(opts: CreateSceneModalOptions<T>, finish: (draft: CreateSceneDraft<T> | null) => void) {
		super(opts.app);
		this.opts = opts;
		this.finish = finish;
		this.selectedRoleplay = opts.roleplays[0] || NEW_CHOICE;
		this.selectedMuse = opts.muses.length ? 0 : -1;
	}

	onOpen(): void {
		this.opts.trapKeys(this, () => this.trySubmit());
		this.modalEl.addClass('mm-create-modal');
		this.setTitle('New scene');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('mm-create');

		this.nameInput = this.addField(contentEl, 'Scene name', 'name', 'text');
		this.nameInput.placeholder = 'Scene name';
		this.nameInput.addEventListener('input', () => {
			this.sceneName = this.nameInput.value;
			this.refreshSubmit();
		});

		const link = this.addField(contentEl, 'Discord link', 'link', 'text');
		link.placeholder = 'Paste a Discord thread link';
		link.addEventListener('input', () => {
			this.threadUrl = link.value;
			this.onLinkEdited();
		});
		this.linkHint = contentEl.createDiv({ cls: 'mm-create__hint' });

		contentEl.createDiv({ cls: 'mm-create__heading', text: 'Roleplay' });
		contentEl.createDiv({
			cls: 'mm-create__sub',
			text: `Folder under ${this.opts.scenesFolder}`,
		});
		this.roleplayHost = contentEl.createDiv({ cls: 'mm-create__grid' });
		this.newRoleplayHost = contentEl.createDiv();

		contentEl.createDiv({ cls: 'mm-create__heading', text: 'Folder' });
		this.folderSearchHost = contentEl.createDiv();
		this.folderHost = contentEl.createDiv({ cls: 'mm-create__grid' });
		this.folderExtraHost = contentEl.createDiv();

		contentEl.createDiv({ cls: 'mm-create__heading', text: 'Muse' });
		if (this.opts.muses.length > 6) {
			const search = this.addField(contentEl, 'Search', 'muse-search', 'text');
			search.placeholder = 'Filter muses';
			search.addEventListener('input', () => {
				this.museQuery = search.value;
				this.renderMuses();
			});
		}
		this.museHost = contentEl.createDiv();

		const count = this.addField(contentEl, 'Participants', 'participants', 'number');
		count.value = this.participants;
		count.addEventListener('input', () => {
			this.participants = count.value;
			this.refreshSubmit();
		});

		const actions = contentEl.createDiv({ cls: 'mm-create__actions' });
		const cancel = actions.createEl('button', { text: 'Cancel', type: 'button' });
		cancel.addEventListener('click', () => this.close());
		this.submitBtn = actions.createEl('button', { text: 'Create scene', type: 'button', cls: 'mod-cta' });
		this.submitBtn.addEventListener('click', () => this.trySubmit());

		this.renderRoleplays();
		this.renderFolders();
		this.renderMuses();
		this.refreshSubmit();
		window.requestAnimationFrame(() => this.nameInput.focus());
	}

	onClose(): void {
		if (!this.settled) {
			this.settled = true;
			this.finish(null);
		}
	}

	private addField(parent: HTMLElement, label: string, focusId: string, type: string): HTMLInputElement {
		const row = parent.createDiv({ cls: 'mm-create__field' });
		row.createEl('label', { text: label, cls: 'mm-create__label' });
		const input = row.createEl('input', { type, cls: 'mm-create__input' });
		input.dataset.mmFocus = focusId;
		return input;
	}

	private roleplayNames(): string[] {
		return Array.from(new Set([...this.opts.roleplays, ...this.extraRoleplays]))
			.filter(Boolean)
			.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
	}

	private currentRoleplay(): string {
		if (this.selectedRoleplay === NEW_CHOICE) return cleanPath(this.newRoleplay);
		return this.selectedRoleplay;
	}

	private onLinkEdited(): void {
		const info = this.opts.parseThreadUrl(this.threadUrl.trim());
		const guildId = info?.guildId || '';
		if (guildId && guildId !== this.lastAutoGuild) {
			this.lastAutoGuild = guildId;
			const hit = this.opts.roleplayForGuild(guildId);
			if (hit?.roleplay) {
				if (!this.roleplayNames().includes(hit.roleplay)) {
					this.extraRoleplays.push(hit.roleplay);
				}
				this.selectedRoleplay = hit.roleplay;
				this.selectedFolder = hit.subfolder || '';
				this.newRoleplay = '';
				this.renderRoleplays();
				this.renderFolders();
			}
		}
		this.renderLinkHint();
		this.refreshSubmit();
	}

	private renderLinkHint(): void {
		const raw = this.threadUrl.trim();
		if (!raw) {
			this.linkHint.setText('');
			this.linkHint.toggleClass('is-error', false);
			return;
		}
		const ok = !!this.opts.parseThreadUrl(raw);
		this.linkHint.setText(ok ? '' : 'Use a discord.com/channels/… link.');
		this.linkHint.toggleClass('is-error', !ok);
	}

	private renderRoleplays(): void {
		this.roleplayHost.empty();
		for (const name of this.roleplayNames()) {
			this.choiceCard(this.roleplayHost, name, '', this.selectedRoleplay === name, () => {
				this.selectedRoleplay = name;
				this.selectedFolder = '';
				this.newFolder = '';
				this.renderRoleplays();
				this.renderFolders();
				this.refreshSubmit();
			});
		}
		this.choiceCard(this.roleplayHost, 'New roleplay', 'Create a folder', this.selectedRoleplay === NEW_CHOICE, () => {
			this.selectedRoleplay = NEW_CHOICE;
			this.selectedFolder = '';
			this.renderRoleplays();
			this.renderFolders();
			this.refreshSubmit();
		});

		this.newRoleplayHost.empty();
		if (this.selectedRoleplay !== NEW_CHOICE) return;
		const input = this.addField(this.newRoleplayHost, 'Name', 'new-rp', 'text');
		input.value = this.newRoleplay;
		input.placeholder = 'Roleplay name';
		input.addEventListener('input', () => {
			this.newRoleplay = input.value;
			this.refreshSubmit();
		});
		window.requestAnimationFrame(() => input.focus());
	}

	private renderFolders(): void {
		this.folderHost.empty();
		this.folderExtraHost.empty();
		const roleplay = this.currentRoleplay();
		const subs = roleplay && this.selectedRoleplay !== NEW_CHOICE
			? this.opts.listSubfolders(roleplay)
			: [];
		if (subs.length > 8) {
			if (!this.folderSearchHost.firstChild) {
				const search = this.addField(this.folderSearchHost, 'Find folder', 'folder-search', 'text');
				search.placeholder = 'Filter folders';
				search.addEventListener('input', () => {
					this.folderQuery = search.value;
					this.renderFolders();
				});
			}
		} else {
			this.folderSearchHost.empty();
			this.folderQuery = '';
		}
		const query = this.folderQuery.trim().toLowerCase();
		let visible = subs.filter((path) => !query || path.toLowerCase().includes(query));
		visible = query ? visible.slice(0, 24) : visible.slice(0, 8);
		if (!query && this.selectedFolder && this.selectedFolder !== NEW_CHOICE && !visible.includes(this.selectedFolder)) {
			visible = [this.selectedFolder, ...visible].slice(0, 8);
		}

		const layoutHint = roleplay ? cleanPath(this.opts.layoutFolder(roleplay, this.chosenMuse())) : '';
		this.choiceCard(this.folderHost, 'This folder', layoutHint || roleplay || 'The roleplay folder', this.selectedFolder === '', () => {
			this.selectedFolder = '';
			this.renderFolders();
			this.refreshSubmit();
		});
		for (const path of visible) {
			this.choiceCard(this.folderHost, path.split('/').pop() || path, path.includes('/') ? path : '', this.selectedFolder === path, () => {
				this.selectedFolder = path;
				this.renderFolders();
				this.refreshSubmit();
			});
		}
		this.choiceCard(this.folderHost, 'New folder', 'Nested path under this roleplay', this.selectedFolder === NEW_CHOICE, () => {
			this.selectedFolder = NEW_CHOICE;
			this.renderFolders();
			this.refreshSubmit();
		});

		if (this.selectedFolder === NEW_CHOICE) {
			const input = this.addField(this.folderExtraHost, 'New folder', 'new-folder', 'text');
			input.value = this.newFolder;
			input.placeholder = 'Folder name';
			input.addEventListener('input', () => {
				this.newFolder = input.value;
				this.refreshSubmit();
			});
		}
	}

	private renderMuses(): void {
		this.museHost.empty();
		const query = this.museQuery.trim().toLowerCase();
		const rows = this.opts.muses
			.map((muse, index) => ({ muse, index }))
			.filter((row) => !query || row.muse.label.toLowerCase().includes(query));
		if (!rows.length) {
			this.museHost.createDiv({ cls: 'mm-create__hint', text: 'No muses match.' });
			return;
		}
		const host = rows.length <= 6 && !query
			? this.museHost.createDiv({ cls: 'mm-create__grid' })
			: this.museHost.createDiv({ cls: 'mm-create__list' });
		for (const row of rows.slice(0, query ? 30 : 40)) {
			this.choiceCard(host, row.muse.label, '', this.selectedMuse === row.index, () => {
				this.selectedMuse = row.index;
				this.renderMuses();
				this.renderFolders();
				this.refreshSubmit();
			});
		}
	}

	private choiceCard(parent: HTMLElement, title: string, desc: string, selected: boolean, onClick: () => void): void {
		const button = parent.createEl('button', { type: 'button', cls: 'mm-choice' });
		button.setAttr('aria-pressed', selected ? 'true' : 'false');
		if (selected) button.addClass('is-selected');
		button.createDiv({ cls: 'mm-choice__title', text: title });
		if (desc) button.createDiv({ cls: 'mm-choice__desc', text: desc });
		button.addEventListener('click', onClick);
	}

	private locationPath(): string | null {
		const roleplay = this.currentRoleplay();
		if (!roleplay) return null;
		let rel = roleplay;
		if (!this.selectedFolder || this.selectedFolder === '') {
			const suffix = cleanPath(this.opts.layoutFolder(roleplay, this.chosenMuse()));
			if (suffix) rel = `${roleplay}/${suffix}`;
		}
		if (this.selectedFolder === NEW_CHOICE) {
			const nested = cleanPath(this.newFolder);
			if (nested) rel = `${roleplay}/${nested}`;
		} else if (this.selectedFolder) {
			rel = `${roleplay}/${cleanPath(this.selectedFolder)}`;
		}
		return `${this.opts.scenesFolder}/${rel}`;
	}

	private chosenMuse(): T | null {
		return this.opts.muses[this.selectedMuse]?.value ?? null;
	}

	private resolvedSceneName(): string {
		const typed = this.sceneName.trim();
		if (typed) return typed.replace(/[\\/]/g, ' ').replace(/\s+/g, ' ').trim();
		const muse = this.chosenMuse() as { name?: string } | null;
		const name = muse && typeof muse.name === 'string' ? muse.name.trim() : '';
		return name ? `${name} - Scene` : '';
	}

	private validationError(): string | null {
		if (!this.resolvedSceneName()) return 'Enter a scene name.';
		const url = this.threadUrl.trim();
		if (!url) return 'Paste a Discord thread link.';
		if (!this.opts.parseThreadUrl(url)) return 'That link is not a Discord channel URL.';
		if (!this.locationPath()) return 'Choose a roleplay folder.';
		if (!this.chosenMuse()) return 'Choose a muse.';
		const count = Number.parseInt(this.participants, 10);
		if (!Number.isFinite(count) || count < 1) return 'Participants must be at least 1.';
		return null;
	}

	private refreshSubmit(): void {
		const error = this.validationError();
		this.submitBtn.disabled = !!error;
		this.submitBtn.setAttr('aria-disabled', error ? 'true' : 'false');
		this.submitBtn.title = error || '';
	}

	private trySubmit(): void {
		const error = this.validationError();
		if (error) {
			this.refreshSubmit();
			return;
		}
		const muse = this.chosenMuse();
		const location = this.locationPath();
		if (!muse || !location) return;
		const count = Number.parseInt(this.participants, 10);
		this.settled = true;
		this.finish({
			muse,
			threadUrl: this.threadUrl.trim(),
			location,
			sceneName: this.resolvedSceneName(),
			participants: count,
		});
		this.close();
	}
}

function cleanPath(input: string): string {
	const cleaned = input
		.replace(/\\/g, '/')
		.split('/')
		.map((part) => part.trim())
		.filter((part) => part && part !== '.' && part !== '..')
		.join('/');
	return normalizePath(cleaned);
}
