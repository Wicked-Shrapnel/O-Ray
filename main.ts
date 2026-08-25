import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	TextFileView,
	WorkspaceLeaf,
	TFile,
	TFolder,
	Menu,
	Modal,
	Notice,
	FuzzySuggestModal,
	normalizePath,
	setIcon,
} from "obsidian";

export const VIEW_TYPE_TEST_PLAN = "test-plan-view";
export const TEST_PLAN_EXTENSION = "testplan";

type PlanStatus = "none" | "passing" | "executing" | "failed";

interface TestStep {
	id: string;
	action: string;
	data: string;
	expectedResult: string;
}

interface DeletedStepRecord {
	id: string;
	originalIndex: number;
	deletedAt: number;
	step: TestStep;
}

interface TestProject {
	id: string;
	name: string;
	folder: string;
}

interface TestPlanData {
	title: string;
	description: string;
	status: PlanStatus;
	projectId: string;
	projectName: string;
	steps: TestStep[];
	deletedSteps: DeletedStepRecord[];
}

interface TestPlanWriterSettings {
	defaultFolder: string;
	defaultProjectId: string;
	projects: TestProject[];
}

const DEFAULT_SETTINGS: TestPlanWriterSettings = {
	defaultFolder: "",
	defaultProjectId: "",
	projects: [],
};

const STATUS_ORDER: PlanStatus[] = ["none", "executing", "passing", "failed"];

const STATUS_LABEL: Record<PlanStatus, string> = {
	none: "Not run",
	executing: "Executing",
	passing: "Passing",
	failed: "Failed",
};

function isPlanStatus(value: unknown): value is PlanStatus {
	return typeof value === "string" && STATUS_ORDER.includes(value as PlanStatus);
}

function makeId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function emptyPlan(title: string, project?: TestProject): TestPlanData {
	return {
		title,
		description: "",
		status: "none",
		projectId: project?.id ?? "",
		projectName: project?.name ?? "",
		steps: [],
		deletedSteps: [],
	};
}

function emptyStep(): TestStep {
	return { id: makeId(), action: "", data: "", expectedResult: "" };
}

function normalizeStep(step: Partial<TestStep>): TestStep {
	return {
		id: step.id ?? makeId(),
		action: step.action ?? "",
		data: step.data ?? "",
		expectedResult: step.expectedResult ?? "",
	};
}

function normalizeDeletedStep(record: Partial<DeletedStepRecord>): DeletedStepRecord {
	return {
		id: record.id ?? makeId(),
		originalIndex:
			typeof record.originalIndex === "number" && Number.isFinite(record.originalIndex)
				? Math.max(0, Math.floor(record.originalIndex))
				: 0,
		deletedAt: typeof record.deletedAt === "number" && Number.isFinite(record.deletedAt) ? record.deletedAt : Date.now(),
		step: record.step ? normalizeStep(record.step) : emptyStep(),
	};
}

function previewText(value: string, fallback: string): string {
	const trimmed = value.trim().replace(/\s+/g, " ");
	return trimmed || fallback;
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	private onChoose: (folder: TFolder) => void;

	constructor(app: App, onChoose: (folder: TFolder) => void) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder("Choose a folder");
	}

	getItems(): TFolder[] {
		const folders: TFolder[] = [];
		const recurse = (folder: TFolder) => {
			folders.push(folder);
			for (const child of folder.children) {
				if (child instanceof TFolder) recurse(child);
			}
		};
		recurse(this.app.vault.getRoot());
		return folders;
	}

	getItemText(folder: TFolder): string {
		return folder.path === "/" ? "(Vault root)" : folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onChoose(folder);
	}
}

class ProjectChoiceModal extends Modal {
	private plugin: TestPlanPlugin;
	private newProjectPanel: HTMLDivElement | null;
	private newProjectInput: HTMLInputElement | null;

	constructor(app: App, plugin: TestPlanPlugin) {
		super(app);
		this.plugin = plugin;
		this.newProjectPanel = null;
		this.newProjectInput = null;
		this.modalEl.addClass("tp-project-modal-shell");
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("tp-project-modal");
		contentEl.createEl("h3", { text: "New test plan" });
		contentEl.createEl("p", {
			cls: "tp-project-modal-desc",
			text: "Choose a project for this plan.",
		});

		const list = contentEl.createDiv({ cls: "tp-project-choice-list" });
		for (const project of this.plugin.settings.projects) {
			const btn = list.createEl("button", { cls: "tp-project-choice" });
			btn.createEl("span", { cls: "tp-project-choice-name", text: project.name || "Untitled project" });
			btn.createEl("span", { cls: "tp-project-choice-folder", text: this.plugin.getProjectFolderPath(project) || "Vault default location" });
			btn.addEventListener("click", async () => {
				this.close();
				await this.plugin.createNewTestPlan(project);
			});
		}

		const defaultBtn = list.createEl("button", { cls: "tp-project-choice tp-project-choice-muted" });
		defaultBtn.createEl("span", { cls: "tp-project-choice-name", text: "No project" });
		defaultBtn.createEl("span", { cls: "tp-project-choice-folder", text: this.plugin.settings.defaultFolder || "Vault default location" });
		defaultBtn.addEventListener("click", async () => {
			this.close();
			await this.plugin.createNewTestPlan();
		});

		const actions = contentEl.createDiv({ cls: "tp-project-modal-actions" });
		const addProjectBtn = actions.createEl("button", { text: "+ New project", cls: "tp-project-modal-add-btn" });
		addProjectBtn.addEventListener("click", () => this.showNewProjectForm());

		this.newProjectPanel = contentEl.createDiv({ cls: "tp-new-project-panel" });
		this.newProjectPanel.style.display = "none";
		this.newProjectPanel.createEl("div", {
			cls: "tp-new-project-label",
			text: "Create a new project here",
		});
		this.newProjectInput = this.newProjectPanel.createEl("input", {
			cls: "tp-new-project-input",
			type: "text",
			value: "New project",
		});
		this.newProjectInput.placeholder = "Project name";

		const newProjectActions = this.newProjectPanel.createDiv({ cls: "tp-confirm-buttons tp-project-modal-actions" });
		const cancelNewBtn = newProjectActions.createEl("button", { text: "Cancel" });
		cancelNewBtn.addEventListener("click", () => this.hideNewProjectForm());
		const saveNewBtn = newProjectActions.createEl("button", { text: "Save project", cls: "mod-cta" });
		saveNewBtn.addEventListener("click", () => void this.createProjectAndPlan());
		this.newProjectInput.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				void this.createProjectAndPlan();
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				this.hideNewProjectForm();
			}
		});
	}

	onClose(): void {
		this.modalEl.removeClass("tp-project-modal-shell");
		this.contentEl.empty();
		this.newProjectPanel = null;
		this.newProjectInput = null;
	}

	private showNewProjectForm(): void {
		if (!this.newProjectPanel || !this.newProjectInput) return;
		this.newProjectPanel.style.display = "";
		window.setTimeout(() => {
			this.newProjectInput?.focus();
			this.newProjectInput?.select();
		}, 0);
	}

	private hideNewProjectForm(): void {
		if (!this.newProjectPanel || !this.newProjectInput) return;
		this.newProjectPanel.style.display = "none";
		this.newProjectInput.value = "New project";
	}

	private async createProjectAndPlan(): Promise<void> {
		const project = await this.plugin.createProject(this.newProjectInput?.value ?? "");
		this.close();
		await this.plugin.createNewTestPlan(project);
	}
}

class ConfirmDeleteModal extends Modal {
	private onConfirm: () => void;
	private stepLabel: string;

	constructor(app: App, stepLabel: string, onConfirm: () => void) {
		super(app);
		this.stepLabel = stepLabel;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("tp-confirm-modal");
		contentEl.createEl("h3", { text: "Delete " + this.stepLabel + "?" });
		contentEl.createEl("p", { text: "This can't be undone.", cls: "tp-confirm-body" });

		const btnRow = contentEl.createDiv({ cls: "tp-confirm-buttons" });
		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const deleteBtn = btnRow.createEl("button", { text: "Delete", cls: "mod-warning" });
		deleteBtn.addEventListener("click", () => {
			this.onConfirm();
			this.close();
		});
		deleteBtn.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class RestoreStepConflictModal extends Modal {
	private stepLabel: string;
	private onReplace: () => void;
	private onSideBySide: () => void;

	constructor(app: App, stepLabel: string, onReplace: () => void, onSideBySide: () => void) {
		super(app);
		this.stepLabel = stepLabel;
		this.onReplace = onReplace;
		this.onSideBySide = onSideBySide;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("tp-confirm-modal");
		contentEl.createEl("h3", { text: "Restore " + this.stepLabel + "?" });
		contentEl.createEl("p", {
			text: "There is already a step in that position. Would you like to replace it or put this under its old position?",
			cls: "tp-confirm-body",
		});

		const btnRow = contentEl.createDiv({ cls: "tp-confirm-buttons" });
		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const sideBySideBtn = btnRow.createEl("button", { text: "Side by side" });
		sideBySideBtn.setAttr("title", "Restore this step under its old position.");
		sideBySideBtn.addEventListener("click", () => {
			this.onSideBySide();
			this.close();
		});

		const replaceBtn = btnRow.createEl("button", { text: "Replace", cls: "mod-warning" });
		replaceBtn.addEventListener("click", () => {
			this.onReplace();
			this.close();
		});
		sideBySideBtn.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class TestPlanSettingTab extends PluginSettingTab {
	plugin: TestPlanPlugin;

	constructor(app: App, plugin: TestPlanPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Test Plan Writer" });

		containerEl.createEl("div", {
			cls: "tp-folder-current",
			text: "Current folder: " + (this.plugin.settings.defaultFolder || "Vault default location"),
		});

		new Setting(containerEl)
			.setName("Default test plan folder")
			.setDesc("Used when a plan is created without a project.")
			.addButton((button) =>
				button.setButtonText("Choose folder").onClick(() => {
					new FolderSuggestModal(this.app, async (folder) => {
						this.plugin.settings.defaultFolder = folder.path === "/" ? "" : folder.path;
						await this.plugin.saveSettings();
						this.display();
					}).open();
				})
			)
			.addButton((button) =>
				button
					.setButtonText("Clear")
					.setDisabled(!this.plugin.settings.defaultFolder)
					.onClick(async () => {
						this.plugin.settings.defaultFolder = "";
						await this.plugin.saveSettings();
						this.display();
					})
			);

		containerEl.createEl("h3", { text: "Projects", cls: "tp-settings-heading" });
		containerEl.createEl("p", {
			cls: "tp-settings-note",
			text: "Projects are stored as subfolders inside the default test plan folder.",
		});

		const projectList = containerEl.createDiv({ cls: "tp-project-settings-list" });
		for (const project of this.plugin.settings.projects) {
			this.createProjectSetting(projectList, project);
		}

		new Setting(containerEl)
			.setName("Add project")
			.setDesc("Create another project destination for test plans.")
			.addButton((button) =>
				button.setButtonText("Add project").setCta().onClick(async () => {
					this.plugin.settings.projects.push({
						id: makeId(),
						name: "New project",
						folder: "",
					});
					await this.plugin.saveSettings();
					this.display();
				})
			);
	}

	private createProjectSetting(parent: HTMLElement, project: TestProject): void {
		const row = parent.createDiv({ cls: "tp-project-setting" });
		const details = row.createDiv({ cls: "tp-project-setting-details" });
		const nameInput = details.createEl("input", {
			cls: "tp-project-name-input",
			type: "text",
			value: project.name,
		});
		nameInput.placeholder = "Project name";
		nameInput.addEventListener("change", async () => {
			project.name = nameInput.value.trim() || "Untitled project";
			await this.plugin.saveSettings();
			this.display();
		});

		details.createEl("div", {
			cls: "tp-project-folder-label",
			text: this.plugin.getProjectFolderPath(project) || "Vault default location",
		});

		const actions = row.createDiv({ cls: "tp-project-setting-actions" });
		const deleteBtn = actions.createEl("button", { text: "Delete", cls: "mod-warning" });
		deleteBtn.addEventListener("click", async () => {
			this.plugin.settings.projects = this.plugin.settings.projects.filter((p) => p.id !== project.id);
			if (this.plugin.settings.defaultProjectId === project.id) {
				this.plugin.settings.defaultProjectId = "";
			}
			await this.plugin.saveSettings();
			this.display();
		});
	}
}

class TestPlanView extends TextFileView {
	data_: TestPlanData;
	private plugin: TestPlanPlugin;
	private editingStepId: string | null;
	private editingField: keyof TestStep | null;
	private originalStep: TestStep | null;
	private fileSaveTimer: number | null;
	private titleRenameTimer: number | null;
	private hasLoadedData: boolean;
	private expandedDeletedStepIds: Set<string>;
	private dragStepIndex: number | null;

	constructor(leaf: WorkspaceLeaf, plugin: TestPlanPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.data_ = emptyPlan("Untitled Test Plan");
		this.editingStepId = null;
		this.editingField = null;
		this.originalStep = null;
		this.fileSaveTimer = null;
		this.titleRenameTimer = null;
		this.hasLoadedData = false;
		this.expandedDeletedStepIds = new Set();
		this.dragStepIndex = null;
	}

	getViewType(): string {
		return VIEW_TYPE_TEST_PLAN;
	}

	getDisplayText(): string {
		return this.data_.title.trim() || (this.file ? this.file.basename : "Test plan");
	}

	getIcon(): string {
		return "list-checks";
	}

	getViewData(): string {
		return JSON.stringify(this.data_, null, 2);
	}

	setViewData(data: string, clear: boolean): void {
		if (clear || !data.trim()) {
			this.data_ = emptyPlan(this.file ? this.file.basename : "Untitled Test Plan");
		} else {
			try {
				const parsed = JSON.parse(data);
				this.data_ = {
					title: parsed.title ?? (this.file ? this.file.basename : "Untitled Test Plan"),
					description: parsed.description ?? "",
					status: isPlanStatus(parsed.status) ? parsed.status : "none",
					projectId: parsed.projectId ?? "",
					projectName: parsed.projectName ?? "",
					steps: Array.isArray(parsed.steps) ? parsed.steps.map((s: Partial<TestStep>) => normalizeStep(s)) : [],
					deletedSteps: Array.isArray(parsed.deletedSteps)
						? parsed.deletedSteps.map((record: Partial<DeletedStepRecord>) => normalizeDeletedStep(record))
						: [],
				};
			} catch (e) {
				this.data_ = emptyPlan(this.file ? this.file.basename : "Untitled Test Plan");
			}
		}
		this.hasLoadedData = true;
		this.restoreDraftBackup();
		this.render();
		this.refreshLeafTitle();
	}

	clear(): void {
		this.hasLoadedData = false;
	}

	async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
	}

	async onClose(): Promise<void> {
		await this.syncTitleToFileName();
		await this.flushFileSave();
		await super.onClose();
	}

	private markDirty(): void {
		this.requestSave();
		this.saveDraftBackup();
		this.queueFileSave();
	}

	private queueFileSave(): void {
		if (this.fileSaveTimer !== null) {
			window.clearTimeout(this.fileSaveTimer);
		}
		this.fileSaveTimer = window.setTimeout(() => {
			this.fileSaveTimer = null;
			void this.flushFileSave();
		}, 250);
	}

	private queueTitleRename(): void {
		if (this.titleRenameTimer !== null) {
			window.clearTimeout(this.titleRenameTimer);
		}
		this.titleRenameTimer = window.setTimeout(() => {
			this.titleRenameTimer = null;
			void this.syncTitleToFileName();
		}, 900);
	}

	async flushFileSave(): Promise<void> {
		if (this.fileSaveTimer !== null) {
			window.clearTimeout(this.fileSaveTimer);
			this.fileSaveTimer = null;
		}
		if (!this.file || !this.hasLoadedData) return;
		await this.app.vault.modify(this.file, this.getViewData());
	}

	async syncTitleToFileName(): Promise<void> {
		if (this.titleRenameTimer !== null) {
			window.clearTimeout(this.titleRenameTimer);
			this.titleRenameTimer = null;
		}
		if (!this.file) return;
		const title = this.data_.title.trim();
		if (!title) return;

		const folderPath = this.file.parent.path === "/" ? "" : this.file.parent.path;
		const safeTitle = this.plugin.sanitizeFolderSegment(title);
		const newPath = this.plugin.getAvailablePath(
			normalizePath(folderPath ? `${folderPath}/${safeTitle}` : safeTitle),
			TEST_PLAN_EXTENSION,
			this.file.path
		);
		if (newPath !== this.file.path) {
			await this.app.fileManager.renameFile(this.file, newPath);
		}
	}

	private getDraftBackupKey(): string | null {
		return this.file ? "test-plan-writer:draft:" + this.file.path : null;
	}

	private normalizePlanData(data: Partial<TestPlanData>): TestPlanData {
		return {
			title: data.title ?? (this.file ? this.file.basename : "Untitled Test Plan"),
			description: data.description ?? "",
			status: isPlanStatus(data.status) ? data.status : "none",
			projectId: data.projectId ?? "",
			projectName: data.projectName ?? "",
			steps: Array.isArray(data.steps) ? data.steps.map((s: Partial<TestStep>) => normalizeStep(s)) : [],
			deletedSteps: Array.isArray(data.deletedSteps)
				? data.deletedSteps.map((record: Partial<DeletedStepRecord>) => normalizeDeletedStep(record))
				: [],
		};
	}

	private planDataScore(data: Partial<TestPlanData>): number {
		let score = 0;
		if (data.title && data.title !== "Untitled Test Plan") score += 2;
		if (data.description?.trim()) score += 2;
		if (data.status && data.status !== "none") score += 1;
		if (data.projectId || data.projectName) score += 1;
		if (Array.isArray(data.steps)) {
			for (const step of data.steps) {
				if (step.action?.trim()) score += 4;
				if (step.data?.trim()) score += 2;
				if (step.expectedResult?.trim()) score += 2;
			}
		}
		if (Array.isArray(data.deletedSteps)) {
			for (const record of data.deletedSteps) {
				if (record.step?.action?.trim()) score += 1;
				if (record.step?.data?.trim()) score += 1;
				if (record.step?.expectedResult?.trim()) score += 1;
			}
		}
		return score;
	}

	private restoreDraftBackup(): void {
		const key = this.getDraftBackupKey();
		const localStorageApi = this.app as unknown as {
			loadLocalStorage?: (key: string) => string | null;
		};
		if (!key || !localStorageApi.loadLocalStorage) return;

		try {
			const raw = localStorageApi.loadLocalStorage(key);
			if (!raw) return;
			const backup = JSON.parse(raw) as { updatedAt?: number; data?: Partial<TestPlanData> };
			if (!backup.data || !backup.updatedAt) return;
			const backupScore = this.planDataScore(backup.data);
			const currentScore = this.planDataScore(this.data_);
			const isNewerThanFile = !this.file || backup.updatedAt > this.file.stat.mtime;
			if (backupScore > currentScore || (isNewerThanFile && backupScore >= currentScore)) {
				this.data_ = this.normalizePlanData(backup.data);
				void this.flushFileSave();
			}
		} catch (e) {
			// Ignore malformed draft backups; the test plan file is still the source of truth.
		}
	}

	private saveDraftBackup(): void {
		const key = this.getDraftBackupKey();
		const localStorageApi = this.app as unknown as {
			saveLocalStorage?: (key: string, value: string) => void;
		};
		if (!key || !localStorageApi.saveLocalStorage) return;
		localStorageApi.saveLocalStorage(key, JSON.stringify({ updatedAt: Date.now(), data: this.data_ }));
	}

	private refreshLeafTitle(): void {
		const leaf = this.leaf as WorkspaceLeaf & {
			updateHeader?: () => void;
		};
		leaf.updateHeader?.();
	}

	private async handleTitleBlur(): Promise<void> {
		await this.syncTitleToFileName();
		await this.flushFileSave();
		this.refreshLeafTitle();
	}

	async applyProject(project?: TestProject): Promise<void> {
		this.data_.projectId = project?.id ?? "";
		this.data_.projectName = project?.name ?? "";
		this.markDirty();
		await this.flushFileSave();
		this.render();
	}

	private createCopyButton(parent: HTMLElement, label: string, getValue: () => string): HTMLButtonElement {
		const button = parent.createEl("button", { cls: "tp-section-copy-btn" });
		setIcon(button, "clipboard");
		button.setAttr("aria-label", "Copy " + label);
		button.addEventListener("click", async (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			const value = getValue();
			if (!value.trim()) {
				new Notice("Nothing to copy for " + label + ".", 2500);
				return;
			}
			await navigator.clipboard.writeText(value);
			new Notice("Copied " + label + ".", 2500);
		});
		return button;
	}

	private resizeTextarea(textarea: HTMLTextAreaElement): void {
		const maxHeight = Math.max(Math.floor(window.innerHeight * 0.6), 120);
		textarea.style.height = "auto";
		const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
		textarea.style.height = nextHeight + "px";
		textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
	}

	private renderLinkedText(parent: HTMLElement, text: string): void {
		const source = text.trim();
		if (!source) {
			parent.setText("Not specified yet.");
			parent.addClass("tp-muted");
			return;
		}

		const linkPattern = /(https?:\/\/[^\s<>()]+|www\.[^\s<>()]+)/gi;
		let lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = linkPattern.exec(source)) !== null) {
			if (match.index > lastIndex) parent.appendText(source.slice(lastIndex, match.index));
			const rawUrl = match[0];
			const href = rawUrl.startsWith("http") ? rawUrl : "https://" + rawUrl;
			const link = parent.createEl("a", {
				text: rawUrl,
				attr: { href, target: "_blank", rel: "noopener noreferrer" },
			});
			link.addEventListener("click", (evt) => evt.stopPropagation());
			lastIndex = match.index + rawUrl.length;
		}
		if (lastIndex < source.length) parent.appendText(source.slice(lastIndex));
	}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("test-plan-view");
		container.ondragover = (evt) => this.handleDragAutoScroll(evt as DragEvent);

		const statusBar = container.createDiv({ cls: "tp-status-bar" });
		const statusBadge = statusBar.createDiv({
			cls: "tp-status-badge tp-status-" + this.data_.status,
			text: STATUS_LABEL[this.data_.status],
		});
		statusBadge.addEventListener("click", (evt) => {
			const menu = new Menu();
			for (const s of STATUS_ORDER) {
				menu.addItem((item) =>
					item
						.setTitle(STATUS_LABEL[s])
						.setChecked(s === this.data_.status)
						.onClick(() => {
							this.data_.status = s;
							this.markDirty();
							void this.flushFileSave();
							this.render();
						})
				);
			}
			menu.showAtMouseEvent(evt);
		});

		const projectBtn = statusBar.createEl("button", {
			cls: "tp-project-badge",
			text: this.data_.projectName || "No project",
		});
		projectBtn.addEventListener("click", (evt) => this.showProjectMenu(evt));

		const titleInput = container.createEl("input", {
			cls: "tp-title-input",
			type: "text",
			value: this.data_.title,
		});
		titleInput.placeholder = "Test plan title";
		titleInput.addEventListener("input", () => {
			this.data_.title = titleInput.value;
			this.markDirty();
			this.queueTitleRename();
			this.refreshLeafTitle();
		});
		titleInput.addEventListener("blur", () => void this.handleTitleBlur());

		const descEl = container.createEl("textarea", {
			cls: "tp-description",
			attr: { placeholder: "Describe what this test plan covers...", rows: "3" },
		});
		descEl.value = this.data_.description;
		this.resizeTextarea(descEl);
		descEl.addEventListener("input", () => {
			this.data_.description = descEl.value;
			this.resizeTextarea(descEl);
			this.markDirty();
		});
		descEl.addEventListener("blur", () => void this.flushFileSave());

		const stepsContainer = container.createDiv({ cls: "tp-steps" });
		if (this.data_.steps.length === 0) {
			const emptyState = stepsContainer.createDiv({ cls: "tp-empty-state" });
			emptyState.createEl("p", { text: "No steps yet." });
			const addFirstBtn = emptyState.createEl("button", {
				cls: "tp-add-step-btn tp-add-first-btn",
				text: "+ Add first step",
			});
			addFirstBtn.addEventListener("click", () => this.addStepAt(0));
		} else {
			this.data_.steps.forEach((step, index) => {
				stepsContainer.appendChild(this.createInsertBar(index));
				this.renderStep(stepsContainer, step, index);
			});
			stepsContainer.appendChild(this.createInsertBar(this.data_.steps.length));
		}
		this.renderDeletedSteps(container);
	}

	private getScrollContainer(): HTMLElement {
		const viewContent = this.contentEl.closest(".view-content");
		if (viewContent instanceof HTMLElement) return viewContent;
		let el: HTMLElement | null = this.contentEl;
		while (el.parentElement) {
			const overflowY = window.getComputedStyle(el).overflowY;
			if (el.scrollHeight > el.clientHeight && (overflowY === "auto" || overflowY === "scroll")) return el;
			el = el.parentElement;
		}
		return el ?? this.contentEl;
	}

	private handleDragAutoScroll(evt: DragEvent): void {
		if (this.dragStepIndex === null) return;
		evt.preventDefault();
		const scrollEl = this.getScrollContainer();
		const rect = scrollEl.getBoundingClientRect();
		const edgeThreshold = 80;
		const topDistance = evt.clientY - rect.top;
		const bottomDistance = rect.bottom - evt.clientY;
		let delta = 0;

		if (topDistance < edgeThreshold) {
			delta = -Math.max(4, Math.round((edgeThreshold - topDistance) / 6));
		} else if (bottomDistance < edgeThreshold) {
			delta = Math.max(4, Math.round((edgeThreshold - bottomDistance) / 6));
		}

		if (delta !== 0) {
			scrollEl.scrollTop += delta;
		}
	}

	private focusStepAfterMove(stepId: string): void {
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(() => {
				const stepEl = this.contentEl.querySelector<HTMLElement>(`[data-step-id="${stepId}"]`);
				if (!stepEl) return;
				stepEl.scrollIntoView({ block: "center", inline: "nearest" });
				stepEl.addClass("is-just-moved");
				window.setTimeout(() => {
					stepEl.removeClass("is-just-moved");
				}, 900);
			});
		});
	}

	private renderPreservingScroll(): void {
		const scrollEl = this.getScrollContainer();
		const scrollTop = scrollEl.scrollTop;
		const scrollLeft = scrollEl.scrollLeft;
		this.render();
		scrollEl.scrollTop = scrollTop;
		scrollEl.scrollLeft = scrollLeft;
		window.requestAnimationFrame(() => {
			scrollEl.scrollTop = scrollTop;
			scrollEl.scrollLeft = scrollLeft;
		});
	}

	private renderStep(parent: HTMLElement, step: TestStep, index: number): void {
		const isEditing = this.editingStepId === step.id;
		const stepEl = parent.createDiv({
			cls: "tp-step" + (isEditing ? " tp-step-expanded" : " tp-step-compact"),
		});
		stepEl.setAttr("data-step-id", step.id);
		stepEl.addEventListener("dragover", (evt) => {
			if (this.dragStepIndex === null) return;
			evt.preventDefault();
			stepEl.addClass("is-drop-target");
			if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
		});
		stepEl.addEventListener("dragleave", () => {
			stepEl.removeClass("is-drop-target");
		});
		stepEl.addEventListener("drop", (evt) => {
			evt.preventDefault();
			stepEl.removeClass("is-drop-target");
			const raw = evt.dataTransfer?.getData("text/plain");
			const fromIndex = raw ? Number(raw) : this.dragStepIndex;
			if (!Number.isInteger(fromIndex) || fromIndex === null || fromIndex === index) return;
			const rect = stepEl.getBoundingClientRect();
			const insertAfter = evt.clientY > rect.top + rect.height / 2;
			this.moveStep(fromIndex, index, insertAfter);
		});
		const header = stepEl.createDiv({ cls: "tp-step-header" });
		const headerLeft = header.createDiv({ cls: "tp-step-header-left" });
		const reorderGroup = headerLeft.createDiv({ cls: "tp-step-reorder-group" });
		const moveUpBtn = reorderGroup.createEl("button", { cls: "tp-icon-btn tp-step-control-btn" });
		moveUpBtn.setAttr("aria-label", "Move step up");
		moveUpBtn.setAttr("title", "Move step up");
		setIcon(moveUpBtn, "chevron-up");
		moveUpBtn.disabled = index === 0;
		moveUpBtn.addEventListener("click", () => this.moveStepByOffset(index, -1));
		const dragHandle = reorderGroup.createEl("button", { cls: "tp-icon-btn tp-drag-handle tp-step-control-btn" });
		dragHandle.setAttr("aria-label", "Drag to reorder step");
		dragHandle.setAttr("title", "Drag to reorder");
		dragHandle.setAttr("draggable", "true");
		setIcon(dragHandle, "grip-vertical");
		dragHandle.addEventListener("dragstart", (evt) => {
			this.dragStepIndex = index;
			stepEl.addClass("is-dragging");
			evt.dataTransfer?.setData("text/plain", String(index));
			if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "move";
		});
		dragHandle.addEventListener("dragend", () => {
			this.dragStepIndex = null;
			stepEl.removeClass("is-dragging");
			stepEl.removeClass("is-drop-target");
		});
		const moveDownBtn = reorderGroup.createEl("button", { cls: "tp-icon-btn tp-step-control-btn" });
		moveDownBtn.setAttr("aria-label", "Move step down");
		moveDownBtn.setAttr("title", "Move step down");
		setIcon(moveDownBtn, "chevron-down");
		moveDownBtn.disabled = index === this.data_.steps.length - 1;
		moveDownBtn.addEventListener("click", () => this.moveStepByOffset(index, 1));
		headerLeft.createEl("span", { cls: "tp-step-number", text: "Step " + (index + 1) });

		const deleteBtn = header.createEl("button", { cls: "tp-icon-btn tp-delete-btn" });
		setIcon(deleteBtn, "x");
		deleteBtn.setAttr("aria-label", "Delete step");
		deleteBtn.addEventListener("click", () => this.confirmDeleteStep(index));

		this.createEditableField(stepEl, step, "action", "Action", "What does this step do?");
		this.createEditableField(stepEl, step, "data", "Data / Links", "Test data, links, or extra information for this step");
		this.createEditableField(stepEl, step, "expectedResult", "Expected Result", "What should happen if this step passes?");

		if (isEditing) {
			const buttons = stepEl.createDiv({ cls: "tp-step-edit-actions" });
			const cancelBtn = buttons.createEl("button", { text: "Cancel" });
			cancelBtn.addEventListener("click", () => void this.cancelStepEdit(index));
			const confirmBtn = buttons.createEl("button", { text: "Confirm", cls: "mod-cta" });
			confirmBtn.addEventListener("click", () => void this.confirmStepEdit());
		}
	}

	private createEditableField(
		parent: HTMLElement,
		step: TestStep,
		field: keyof TestStep,
		label: string,
		placeholder: string
	): void {
		if (field === "id") return;
		const isActive = this.editingStepId === step.id && this.editingField === field;
		if (!isActive) {
			this.createPreviewRow(parent, label, step[field], field === "data", () => this.beginFieldEdit(step, field));
			return;
		}

		const wrap = parent.createDiv({ cls: "tp-field tp-field-active" });
		const labelRow = wrap.createDiv({ cls: "tp-field-label-row" });
		labelRow.createEl("label", { cls: "tp-field-label", text: label });
		this.createCopyButton(labelRow, label, () => step[field]);
		const textarea = wrap.createEl("textarea", {
			cls: "tp-field-input",
			attr: { placeholder, rows: "2" },
		});
		textarea.value = step[field];
		this.resizeTextarea(textarea);
		window.setTimeout(() => {
			textarea.focus();
			textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		});
		textarea.addEventListener("input", () => {
			step[field] = textarea.value;
			this.resizeTextarea(textarea);
			this.markDirty();
		});
		textarea.addEventListener("blur", () => void this.flushFileSave());
	}

	private createPreviewRow(
		parent: HTMLElement,
		label: string,
		value: string,
		linkify: boolean,
		onEdit: () => void
	): void {
		const row = parent.createDiv({ cls: "tp-preview-row tp-preview-editable" });
		row.setAttr("role", "button");
		row.setAttr("tabindex", "0");
		row.addEventListener("click", onEdit);
		row.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" || evt.key === " ") {
				evt.preventDefault();
				onEdit();
			}
		});
		const heading = row.createDiv({ cls: "tp-preview-heading" });
		heading.createEl("span", { cls: "tp-preview-label", text: label });
		this.createCopyButton(heading, label, () => value);
		const valueEl = row.createDiv({ cls: "tp-preview-value" });
		if (linkify) {
			this.renderLinkedText(valueEl, value);
		} else {
			valueEl.setText(previewText(value, "Not specified yet."));
			if (!value.trim()) valueEl.addClass("tp-muted");
		}
	}

	private beginFieldEdit(step: TestStep, field: keyof TestStep): void {
		if (field === "id") return;
		if (this.editingStepId !== step.id) {
			this.originalStep = { ...step };
		}
		this.editingStepId = step.id;
		this.editingField = field;
		this.render();
	}

	private async confirmStepEdit(): Promise<void> {
		const step = this.data_.steps.find((candidate) => candidate.id === this.editingStepId);
		if (step && !step.action.trim()) {
			new Notice("Action is required before confirming a step.", 3500);
			this.editingField = "action";
			this.render();
			return;
		}
		this.editingStepId = null;
		this.editingField = null;
		this.originalStep = null;
		this.markDirty();
		await this.flushFileSave();
		this.renderPreservingScroll();
	}

	private async cancelStepEdit(index: number): Promise<void> {
		if (this.originalStep) {
			this.data_.steps[index] = { ...this.originalStep };
			this.markDirty();
		} else {
			this.data_.steps.splice(index, 1);
			this.markDirty();
		}
		this.editingStepId = null;
		this.editingField = null;
		this.originalStep = null;
		await this.flushFileSave();
		this.renderPreservingScroll();
	}

	private confirmDeleteStep(index: number): void {
		new ConfirmDeleteModal(this.app, "Step " + (index + 1), () => {
			this.archiveDeletedStep(index);
			this.editingStepId = null;
			this.editingField = null;
			this.originalStep = null;
			void this.flushFileSave();
			this.renderPreservingScroll();
		}).open();
	}

	private archiveDeletedStep(index: number): void {
		const [deletedStep] = this.data_.steps.splice(index, 1);
		if (!deletedStep) return;
		this.data_.deletedSteps.unshift({
			id: makeId(),
			originalIndex: index,
			deletedAt: Date.now(),
			step: { ...deletedStep },
		});
		this.data_.deletedSteps = this.data_.deletedSteps.slice(0, 25);
		this.markDirty();
	}

	private restoreDeletedStep(index: number, mode: "insert" | "replace" | "beside" = "insert"): void {
		const [record] = this.data_.deletedSteps.splice(index, 1);
		if (!record) return;
		const originalIndex = Math.max(0, Math.min(record.originalIndex, this.data_.steps.length));
		if (mode === "replace" && record.originalIndex < this.data_.steps.length) {
			this.data_.steps[record.originalIndex] = { ...record.step };
		} else {
			const insertAt = mode === "beside" ? Math.min(originalIndex + 1, this.data_.steps.length) : originalIndex;
			this.data_.steps.splice(insertAt, 0, { ...record.step });
		}
		this.expandedDeletedStepIds.delete(record.id);
		this.markDirty();
		this.render();
		this.focusStepAfterMove(record.step.id);
	}

	private requestRestoreDeletedStep(index: number): void {
		const record = this.data_.deletedSteps[index];
		if (!record) return;
		const originalSlotOccupied = record.originalIndex >= 0 && record.originalIndex < this.data_.steps.length;
		if (!originalSlotOccupied) {
			this.restoreDeletedStep(index);
			void this.flushFileSave();
			return;
		}

		new RestoreStepConflictModal(
			this.app,
			"Step " + (record.originalIndex + 1),
			() => {
				this.restoreDeletedStep(index, "replace");
				void this.flushFileSave();
			},
			() => {
				this.restoreDeletedStep(index, "beside");
				void this.flushFileSave();
			}
		).open();
	}

	private clearDeletedSteps(): void {
		this.data_.deletedSteps = [];
		this.markDirty();
	}

	private renderDeletedSteps(parent: HTMLElement): void {
		if (!this.data_.deletedSteps.length) return;

		const section = parent.createDiv({ cls: "tp-deleted-steps" });
		const header = section.createDiv({ cls: "tp-deleted-steps-header" });
		header.createEl("h3", { text: "Recently deleted" });
		const clearBtn = header.createEl("button", { text: "Clear all", cls: "tp-deleted-clear-btn" });
		clearBtn.addEventListener("click", () => {
			this.clearDeletedSteps();
			void this.flushFileSave();
			this.renderPreservingScroll();
		});

		const list = section.createDiv({ cls: "tp-deleted-steps-list" });
		this.data_.deletedSteps.forEach((record, index) => {
			const isExpanded = this.expandedDeletedStepIds.has(record.id);
			const item = list.createDiv({ cls: "tp-deleted-step" + (isExpanded ? " is-expanded" : "") });
			const itemHeader = item.createEl("button", { cls: "tp-deleted-step-header" });
			itemHeader.setAttr("aria-expanded", String(isExpanded));
			itemHeader.addEventListener("click", () => {
				if (isExpanded) {
					this.expandedDeletedStepIds.delete(record.id);
				} else {
					this.expandedDeletedStepIds.add(record.id);
				}
				this.renderPreservingScroll();
			});
			const itemText = itemHeader.createDiv({ cls: "tp-deleted-step-text" });
			itemText.createEl("div", {
				cls: "tp-deleted-step-title",
				text: "Step " + (record.originalIndex + 1),
			});
			itemText.createEl("div", {
				cls: "tp-deleted-step-summary",
				text: previewText(record.step.action, "No action"),
			});
			const restoreBtn = item.createEl("button", { text: "Restore", cls: "tp-deleted-restore-btn" });
			restoreBtn.addEventListener("click", () => {
				this.requestRestoreDeletedStep(index);
			});
			if (isExpanded) {
				const details = item.createDiv({ cls: "tp-deleted-step-details" });
				this.renderDeletedStepDetail(details, "Action", record.step.action);
				this.renderDeletedStepDetail(details, "Data / Links", record.step.data, true);
				this.renderDeletedStepDetail(details, "Expected Result", record.step.expectedResult);
			}
		});
	}

	private renderDeletedStepDetail(parent: HTMLElement, label: string, value: string, linkify = false): void {
		const row = parent.createDiv({ cls: "tp-deleted-detail-row" });
		row.createEl("div", { cls: "tp-deleted-detail-label", text: label });
		const valueEl = row.createDiv({ cls: "tp-deleted-detail-value" });
		if (linkify) {
			this.renderLinkedText(valueEl, value);
		} else {
			valueEl.setText(previewText(value, "Not specified yet."));
			if (!value.trim()) valueEl.addClass("tp-muted");
		}
	}

	private addStepAt(index: number): void {
		if (this.editingStepId) {
			new Notice("Confirm or cancel the current step before adding another.", 3500);
			return;
		}
		const step = emptyStep();
		this.data_.steps.splice(index, 0, step);
		this.editingStepId = step.id;
		this.editingField = "action";
		this.originalStep = null;
		this.render();
	}

	private moveStep(fromIndex: number, toIndex: number, insertAfter = false): void {
		if (fromIndex === toIndex) return;
		if (fromIndex < 0 || fromIndex >= this.data_.steps.length) return;
		if (toIndex < 0 || toIndex > this.data_.steps.length) return;

		const [step] = this.data_.steps.splice(fromIndex, 1);
		if (!step) return;
		const insertAt = insertAfter
			? fromIndex < toIndex
				? toIndex
				: toIndex + 1
			: fromIndex < toIndex
				? toIndex - 1
				: toIndex;
		this.data_.steps.splice(Math.max(0, Math.min(insertAt, this.data_.steps.length)), 0, step);
		this.markDirty();
		this.renderPreservingScroll();
		this.focusStepAfterMove(step.id);
	}

	private moveStepByOffset(index: number, offset: -1 | 1): void {
		const targetIndex = index + offset;
		if (targetIndex < 0 || targetIndex >= this.data_.steps.length) return;
		this.moveStep(index, targetIndex, offset > 0);
	}

	private createInsertBar(index: number): HTMLElement {
		const bar = document.createElement("div");
		bar.addClass("tp-insert-bar");
		if (this.editingStepId) {
			bar.addClass("is-hidden");
			return bar;
		}
		const btn = bar.createEl("button", { cls: "tp-insert-btn", text: "+ Add step" });
		btn.addEventListener("click", () => this.addStepAt(index));
		bar.addEventListener("dragover", (evt) => {
			if (this.dragStepIndex === null) return;
			evt.preventDefault();
			bar.addClass("is-drop-target");
			if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
		});
		bar.addEventListener("dragleave", () => {
			bar.removeClass("is-drop-target");
		});
		bar.addEventListener("drop", (evt) => {
			if (this.dragStepIndex === null) return;
			evt.preventDefault();
			bar.removeClass("is-drop-target");
			const raw = evt.dataTransfer?.getData("text/plain");
			const fromIndex = raw ? Number(raw) : this.dragStepIndex;
			if (!Number.isInteger(fromIndex) || fromIndex === null) return;
			this.moveStep(fromIndex, index);
		});
		return bar;
	}

	private showProjectMenu(evt: MouseEvent): void {
		const menu = new Menu();
		for (const project of this.plugin.settings.projects) {
			menu.addItem((item) =>
				item
					.setTitle(project.name || "Untitled project")
					.setChecked(project.id === this.data_.projectId)
					.onClick(() => void this.changeProject(project))
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("No project")
				.setChecked(!this.data_.projectId)
				.onClick(() => void this.changeProject(undefined))
		);
		menu.showAtMouseEvent(evt);
	}

	private async changeProject(project?: TestProject): Promise<void> {
		this.data_.projectId = project?.id ?? "";
		this.data_.projectName = project?.name ?? "";
		this.markDirty();
		await this.flushFileSave();
		await this.plugin.movePlanToProjectFolder(this.file, project);
		this.render();
	}
}

export default class TestPlanPlugin extends Plugin {
	settings: TestPlanWriterSettings;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new TestPlanSettingTab(this.app, this));
		this.registerView(VIEW_TYPE_TEST_PLAN, (leaf) => new TestPlanView(leaf, this));
		this.registerExtensions([TEST_PLAN_EXTENSION], VIEW_TYPE_TEST_PLAN);

		this.addRibbonIcon("list-checks", "New test plan", () => {
			this.openNewPlanPicker();
		});

		this.addCommand({
			id: "create-new-test-plan",
			name: "Create new test plan",
			callback: () => this.openNewPlanPicker(),
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (!Array.isArray(this.settings.projects)) {
			this.settings.projects = [];
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	openNewPlanPicker(): void {
		new ProjectChoiceModal(this.app, this).open();
	}

	private getFolder(folderPath: string): TFolder | null {
		const normalized = folderPath.trim();
		if (!normalized) return null;
		const folder = this.app.vault.getAbstractFileByPath(normalized);
		return folder instanceof TFolder ? folder : null;
	}

	sanitizeFolderSegment(name: string): string {
		return (name.trim() || "Untitled project")
			.replace(/[\\/:*?"<>|#^[\]]+/g, "-")
			.replace(/\s+/g, " ")
			.trim();
	}

	getProjectFolderPath(project?: TestProject): string {
		if (!project) return this.settings.defaultFolder;
		const mainFolder = this.settings.defaultFolder.trim();
		const projectFolder = this.sanitizeFolderSegment(project.name);
		return normalizePath(mainFolder ? `${mainFolder}/${projectFolder}` : projectFolder);
	}

	async createProject(name: string): Promise<TestProject> {
		const project: TestProject = {
			id: makeId(),
			name: name.trim() || "New project",
			folder: "",
		};
		this.settings.projects.push(project);
		await this.saveSettings();
		return project;
	}

	private async ensureFolderPath(folderPath: string): Promise<void> {
		const normalized = normalizePath(folderPath.trim());
		if (!normalized || normalized === "/") return;

		let current = "";
		for (const segment of normalized.split("/")) {
			current = current ? `${current}/${segment}` : segment;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) continue;
			if (existing) throw new Error(`Cannot create folder "${current}" because a file already exists there.`);
			await this.app.vault.createFolder(current);
		}
	}

	async movePlanToProjectFolder(file: TFile | null, project?: TestProject): Promise<void> {
		if (!file) return;
		const folderPath = this.getProjectFolderPath(project);
		const targetFolder = folderPath || this.settings.defaultFolder;
		if (!targetFolder) return;

		await this.ensureFolderPath(targetFolder);
		const newPath = this.getAvailablePath(normalizePath(`${targetFolder}/${file.basename}`), TEST_PLAN_EXTENSION, file.path);
		if (newPath === file.path) return;
		await this.app.fileManager.renameFile(file, newPath);
	}

	async createNewTestPlan(project?: TestProject): Promise<void> {
		const configuredFolder = this.getProjectFolderPath(project);
		await this.ensureFolderPath(configuredFolder);
		const fallbackFolder = this.app.fileManager.getNewFileParent("");
		const folderPath = configuredFolder || (fallbackFolder.path === "/" ? "" : fallbackFolder.path);
		const title = "Untitled Test Plan";
		const base = folderPath ? folderPath + "/" + title : title;
		const fileName = this.getAvailablePath(base, TEST_PLAN_EXTENSION);
		const content = JSON.stringify(emptyPlan(title, project), null, 2);
		const file = await this.app.vault.create(fileName, content);
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.openFile(file);
		if (project && leaf.view instanceof TestPlanView) {
			await leaf.view.applyProject(project);
		}
	}

	getAvailablePath(basePath: string, extension: string, allowedPath = ""): string {
		let candidate = basePath + "." + extension;
		let counter = 1;
		while (candidate !== allowedPath && this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = basePath + " " + counter + "." + extension;
			counter++;
		}
		return candidate;
	}

	onunload(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TEST_PLAN)) {
			const view = leaf.view;
			if (view instanceof TestPlanView) {
				void view.syncTitleToFileName();
				void view.flushFileSave();
			}
		}
	}
}
