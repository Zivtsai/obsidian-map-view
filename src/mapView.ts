import { TAbstractFile, Editor, ButtonComponent, MarkdownView, getAllTags, ItemView, MenuItem, Menu, TFile, TextComponent, DropdownComponent, WorkspaceLeaf } from 'obsidian';
import * as leaflet from 'leaflet';
// Ugly hack for obsidian-leaflet compatability, see https://github.com/esm7/obsidian-map-view/issues/6
// @ts-ignore
import * as leafletFullscreen from 'leaflet-fullscreen';
import '@fortawesome/fontawesome-free/js/all.min';
import 'leaflet/dist/leaflet.css';
import { GeoSearchControl, OpenStreetMapProvider } from 'leaflet-geosearch';
import 'leaflet-geosearch/dist/geosearch.css';

import * as consts from 'src/consts';
import { PluginSettings, DEFAULT_SETTINGS } from 'src/settings';
import { MarkersMap, FileMarker, getIconFromOptions } from 'src/markers';
import MapViewPlugin from 'src/main';
import * as utils from 'src/utils';

type MapState = {
	mapZoom: number;
	mapCenter: leaflet.LatLng;
	tags: string[];
	version: number;
};

export class MapView extends ItemView {
	private settings: PluginSettings;
	// The private state needs to be updated solely via updateMapToState
	private state: MapState;
	private display = new class {
		map: leaflet.Map;
		markers: MarkersMap;
		mapDiv: HTMLDivElement;
		tagsBox: TextComponent;
	};
	private plugin: MapViewPlugin;
	private defaultState: MapState;
	private newPaneLeaf: WorkspaceLeaf;
	private isOpen: boolean = false;
	private createTimer:any;
	private refreshTimer:any;
	private boxTimer:any;

	public onAfterOpen: (map: leaflet.Map, markers: MarkersMap) => any = null;

	constructor(leaf: WorkspaceLeaf, settings: PluginSettings, plugin: MapViewPlugin) {
		super(leaf);
		this.navigation = true;
		this.settings = settings;
		this.plugin = plugin;
		// Create the default state by the configuration
		this.defaultState = {
			mapZoom: this.settings.defaultZoom || consts.DEFAULT_ZOOM,
			mapCenter: this.settings.defaultMapCenter || consts.DEFAULT_CENTER,
			tags: this.settings.defaultTags || consts.DEFAULT_TAGS,
			version: 0
		};

		this.getState = () => this.state;
		this.setState = async (state: MapState, result: any = null)  => {
			if (state) {
				console.log(`Received setState:`, state);
				// We give the given state priority by setting a high version
				state.version = 100;
				this.updateMapToState(state);
			}
		};

		this.app.metadataCache.on('resolved', () => {
			this.app.workspace.onLayoutReady(() => {
				this.display.map.whenReady(() => {
					this.updateMapToState(this.defaultState).then(() => {
						this.refreshView();
						if (this.onAfterOpen != null)
							this.onAfterOpen(this.display.map, this.display.markers);
					});
				});

				this.app.vault.on('rename', (file, oldPath) => this.handleRenameMarker(file, oldPath));
				this.app.metadataCache.on('changed', file => this.handleUpdateMarker(file));
				this.app.vault.on('delete', file => this.handleRemoveMarker(file));

				// unfortunately create recieves an abstract file so whenever we detect created files we have to refresh the cache,
				// in case of rapid creation we do this on a timeout in order to refresh only once
				this.app.vault.on('create', () => {
					if (this.createTimer) { window.clearTimeout(this.createTimer); this.createTimer = null; }
					this.createTimer = window.setTimeout(() => {
						this.createTimer = null;
						this.plugin.cacheReset().then(() => this.updateMapToState(this.state,true));
					}, 2000);
				});
			});
		});
	}

	getViewType() { return 'map'; }
	getDisplayText() { return 'Interactive Map View'; }

	onOpen() {
		var that = this;
		this.isOpen = true;
		this.state = this.defaultState;
		let controlsDiv = createDiv({
			'cls': 'graph-controls',
			'text': 'Filters'
		}, (el: HTMLDivElement) => {
			el.style.position = 'fixed';
			el.style.zIndex = '2';
		});
		this.display.tagsBox = new TextComponent(controlsDiv);
		this.display.tagsBox.setPlaceholder('Tags, e.g. "#one,#two"');
		this.display.tagsBox.onChange(async (tagsBox: string) => {
			if (this.boxTimer) { window.clearTimeout(this.boxTimer); this.boxTimer = null; }
			this.boxTimer = window.setTimeout(() => {
				this.boxTimer = null;
				that.state.tags = tagsBox?.length ? tagsBox.split(',').filter(t => t.length > 0) : null;
				this.updateMapToState(this.state);
			}, 600); //enough time to not trigger while typing without feeling slow to respond
		});
		let tagSuggestions = new DropdownComponent(controlsDiv);
		tagSuggestions.setValue('Quick add tag');
		tagSuggestions.addOption('', 'Quick add tag');
		for (const tagName of this.getAllTagNames())
			tagSuggestions.addOption(tagName, tagName);
		tagSuggestions.onChange(value => {
			let currentTags = this.display.tagsBox.getValue();
			if (currentTags.indexOf(value) < 0) {
				this.display.tagsBox.setValue(currentTags.split(',').filter(tag => tag.length > 0).concat([value]).join(','));
			}
			tagSuggestions.setValue('Quick add tag');
			this.display.tagsBox.inputEl.focus();
			this.display.tagsBox.onChanged();
		});
		let goDefault = new ButtonComponent(controlsDiv);
		goDefault
			.setButtonText('Reset')
			.setTooltip('Reset the view to the defined default.')
			.onClick(() => {
				let newState = {
					mapZoom: this.settings.defaultZoom || consts.DEFAULT_ZOOM,
					mapCenter: this.settings.defaultMapCenter || consts.DEFAULT_CENTER,
					tags: this.settings.defaultTags || consts.DEFAULT_TAGS,
					version: this.state.version + 1
				};
				this.updateMapToState(newState);
			});
		let fitButton = new ButtonComponent(controlsDiv);
		fitButton
			.setButtonText('Fit')
			.setTooltip('Set the map view to fit all currently-displayed markers.')
			.onClick(() => this.autoFitMapToMarkers());
		let setDefault = new ButtonComponent(controlsDiv);
		setDefault
			.setButtonText('Set as Default')
			.setTooltip('Set this view (map state & filters) as default.')
			.onClick(async () => {
				this.settings.defaultZoom = this.state.mapZoom;
				this.settings.defaultMapCenter = this.state.mapCenter;
				this.settings.defaultTags = this.state.tags;
				await this.plugin.saveSettings();
			});
		this.contentEl.style.padding = '0px 0px';
		this.contentEl.append(controlsDiv);
		this.display.mapDiv = createDiv({ cls: 'map' }, (el: HTMLDivElement) => {
			el.style.zIndex = '1';
			el.style.width = '100%';
			el.style.height = '100%';
		});
		this.contentEl.append(this.display.mapDiv);

		this.createMap();

		return super.onOpen();
	}

	onClose() {
		this.isOpen = false;
		return super.onClose();
	}

	onResize() {
		this.display.map.invalidateSize();
	}

	async createMap() {
		// LeafletJS compatability: disable tree-shaking for the full-screen module
		var dummy = leafletFullscreen;
		this.display.map = new leaflet.Map(this.display.mapDiv, {
			center: new leaflet.LatLng(40.731253, -73.996139),
			zoom: 13,
			zoomControl: false,
			worldCopyJump: true,
			maxBoundsViscosity: 1.0
		});
		leaflet.control.zoom({
			position: 'topright'
		}).addTo(this.display.map);
		const attribution = this.settings.tilesUrl === DEFAULT_SETTINGS.tilesUrl ?
			'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' : '';
		this.display.map.addLayer(new leaflet.TileLayer(this.settings.tilesUrl, {
			maxZoom: 20,
			subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
			attribution: attribution,
			className: this.settings.darkMode ? "dark-mode" : ""
		}));
		const searchControl = GeoSearchControl({
			provider: new OpenStreetMapProvider(),
			position: 'topright',
			marker: {
				icon: getIconFromOptions(consts.SEARCH_RESULT_MARKER as leaflet.BaseIconOptions)
			},
			style: 'button'
		});
		this.display.map.addControl(searchControl);
		this.display.map.on('zoomend', (event: leaflet.LeafletEvent) => {
			this.state.mapZoom = this.display.map.getZoom();
		});
		this.display.map.on('moveend', (event: leaflet.LeafletEvent) => {
			this.state.mapCenter = this.display.map.getCenter();
		});
		this.display.map.on('contextmenu', async (event: leaflet.LeafletMouseEvent) => {
			let mapPopup = new Menu(this.app);
			mapPopup.setNoIcon();
			mapPopup.addItem((item: MenuItem) => {
				const location = `${event.latlng.lat},${event.latlng.lng}`;
				item.setTitle('New note here');
				item.onClick(async ev => {
					const newFileName = utils.formatWithTemplates(this.settings.newNoteNameFormat);
					const file: TFile = await utils.newNote(this.app, 'singleLocation', this.settings.newNotePath,
						newFileName, location, this.settings.newNoteTemplate);
					this.goToFile(file, ev.ctrlKey);
				});
			});
			mapPopup.addItem((item: MenuItem) => {
				const location = `${event.latlng.lat},${event.latlng.lng}`;
				item.setTitle('New multi-location note');
				item.onClick(async ev => {
					const newFileName = utils.formatWithTemplates(this.settings.newNoteNameFormat);
					const file: TFile = await utils.newNote(this.app, 'multiLocation', this.settings.newNotePath,
						newFileName, location, this.settings.newNoteTemplate);
					this.goToFile(file, ev.ctrlKey);
				});
			});
			mapPopup.addItem((item: MenuItem) => {
				const location = `${event.latlng.lat},${event.latlng.lng}`;
				item.setTitle(`Copy location as inline`);
				item.onClick(_ev => {
					navigator.clipboard.writeText(`\`location: [${location}]\``);
				});
			});
			mapPopup.addItem((item: MenuItem) => {
				const location = `${event.latlng.lat},${event.latlng.lng}`;
				item.setTitle(`Copy location as front matter`);
				item.onClick(_ev => {
					navigator.clipboard.writeText(`---\nlocation: [${location}]\n---\n\n`);
				});
			});
			mapPopup.addItem((item: MenuItem) => {
				const location = `${event.latlng.lat},${event.latlng.lng}`;
				item.setTitle(`Copy location as coordinates`);
				item.onClick(_ev => {
					navigator.clipboard.writeText(location);
				});
			});
			mapPopup.addItem((item: MenuItem) => {
				item.setTitle('Open in Google Maps');
				item.onClick(_ev => {
					open(`https://maps.google.com/?q=${event.latlng.lat},${event.latlng.lng}`);
				});
			});
			mapPopup.showAtPosition(event.originalEvent);
		});
	}

	// Updates the map to the given state and then sets the state accordingly, but only if the given state version
	// is not lower than the current state version (so concurrent async updates always keep the latest one)
	async updateMapToState(state: MapState, updateFromCache = false) {
		// If the state we we're asked to update is old (e.g. because while we were building markers a newer instance
		// of the method was called), cancel the update
		if (state.version < this.state.version) return;
		else this.state = state;
		this.state.tags = this.state.tags || [];
		this.display.tagsBox.setValue(this.state.tags.filter(tag => tag.length > 0).join(','));

		this.fetchAndUpdateMapMarkers(updateFromCache);
		this.cleanMarkers();
		for(let marker of this.markerQuery(state.tags)) this.showOrHideMarker(marker);	
	}

	private fetchAndUpdateMapMarkers(updateFromCache = false) {
		if (!this.display.markers || updateFromCache) {
			this.display.markers ??= new Map();
			for (const promise of this.plugin.fileCache) {
				promise.then(async marker => {
					if (!marker) return;
					this.updateMarker(marker);
				});
			}
		} else for (const marker of this.display.markers.values())
			this.updateMarker(marker);
	}

	private async handleRemoveMarker(removed: TAbstractFile) {
		if (!this.display.map || !this.isOpen) return;
		this.display.markers.forEach(marker =>{
			if(marker.file.path == removed.path) {
				this.display.markers.delete(marker.id);
				marker.mapMarker.removeFrom(this.display.map);
			}
		});
	}
	private handleRenameMarker(renamed: TAbstractFile, oldPath: string) {
		if (!this.display.map || !this.isOpen) return;
		this.display.markers.forEach(marker => {if(marker.file.path == oldPath) Object.assign(marker.file,renamed)});
	}
	/* 
		this currently recalculates all markers for a file that is changed while the map is open,
		which could potentially be a bottleneck on a huge file with tons of markers,
		but it's doubtful this would ever be an issue and finding exactly which marker changed adds unnecessary complexity
	*/
	private async handleUpdateMarker(changed: TFile) {
		if (!this.display.map || !this.isOpen) return;
		this.handleRemoveMarker(changed);
		this.plugin.cacheRemove(changed);
		for(let promise of this.plugin.cacheAdd(changed))
			promise.then(marker => this.updateMarker(marker));
	}

	updateMarker(marker: FileMarker|FileMarker[]) {
		if(!marker) return;
	
		if (marker instanceof Array) {
			marker.forEach(m => this.updateMarker(m));
			return;
		}

		let existingMarker = this.display.markers.get(marker.id);
		if (!existingMarker?.isSame(marker))  {
			// New marker - create it
			marker.mapMarker = leaflet.marker(marker.location, { icon: marker.icon || new leaflet.Icon.Default() })
				.addTo(this.display.map)
				.bindTooltip(marker.file.name);
			marker.mapMarker.on('click', (event: leaflet.LeafletMouseEvent) => {
				this.goToMarker(marker, event.originalEvent.ctrlKey, true);
			});
			marker.mapMarker.getElement().addEventListener('contextmenu', (ev: MouseEvent) => {
				let mapPopup = new Menu(this.app);
				mapPopup.setNoIcon();
				mapPopup.addItem((item: MenuItem) => {
					item.setTitle('Open note');
					item.onClick(async ev => { this.goToMarker(marker, ev.ctrlKey, true); });
				});
				mapPopup.addItem((item: MenuItem) => {
					item.setTitle('Open in Google Maps');
					item.onClick(ev => {
						open(`https://maps.google.com/?q=${marker.location.lat},${marker.location.lng}`);
					});
				});
				mapPopup.showAtPosition(ev);
				ev.stopPropagation();
			});
			this.display.markers.set(marker.id, marker);
			this.refreshView();
		}
	}

	/** has "side effect" of marking unmatched markers dirty so they are removed  */
	*markerQuery(tags: string[]) {
		//NOTE: this way of doing things means any tag filtering automatically excludes non-markdown files
		//TODO: make it possible to insert multiple inclusion strategies, e.g. filter by file type
		for (const [markerId,marker] of this.display.markers) {
			if (tags?.length && !this.app.metadataCache.getFileCache(marker.file)?.tags?.some(t => tags.includes(t.tag)))
				 marker.dirty = true;
			yield marker;
		}
	}
	cleanMarkers(){
		this.display.markers.forEach(marker => marker.dirty = false);
	}
	showOrHideMarker(marker: FileMarker) {
		if (marker?.dirty) marker.mapMarker.removeFrom(this.display.map);
		else marker.mapMarker.addTo(this.display.map);
		this.refreshView();
	}

	// each refresh request resets the timer unless it's been more than a second since the first request
	// this causes periodic refreshes every second when getting many sequential requests
	refreshStartTime:number;
	refreshView() {
		this.refreshStartTime ??= Date.now();
		if (this.refreshTimer){
			if(Date.now() - this.refreshStartTime < 1000) window.clearTimeout(this.refreshTimer);
			else return;
		}
		this.refreshTimer = window.setTimeout(async () => {
			this.refreshTimer = null;
			this.refreshStartTime = null;
			if (this.state.mapCenter && this.state.mapZoom)
				this.display.map.setView(this.state.mapCenter, this.state.mapZoom);
			if(this.settings.autoZoom) this.autoFitMapToMarkers();
		}, 100);

	}

	async autoFitMapToMarkers() {
		if (this.display.markers.size > 0) {
			const locations: leaflet.LatLng[] = Array.from(this.display.markers.values()).map(fileMarker => fileMarker.location);
			this.display.map.fitBounds(leaflet.latLngBounds(locations));
		}
	}

	async goToFile(file: TFile, useCtrlKeyBehavior: boolean, fileLocation?: number, highlight?: boolean) {
		let leafToUse = this.app.workspace.activeLeaf;
		const defaultDifferentPane = this.settings.markerClickBehavior != 'samePane';
		// Having a pane to reuse means that we previously opened a note in a new pane and that pane still exists (wasn't closed)
		const havePaneToReuse = this.newPaneLeaf && this.newPaneLeaf.view && this.settings.markerClickBehavior != 'alwaysNew';
		if (havePaneToReuse || (defaultDifferentPane && !useCtrlKeyBehavior) || (!defaultDifferentPane && useCtrlKeyBehavior)) {
			// We were instructed to use a different pane for opening the note.
			// We go here in the following cases:
			// 1. An existing pane to reuse exists (the user previously opened it, with or without Ctrl).
			//    In this case we use the pane regardless of the default or of Ctrl, assuming that if a user opened a pane
			//    once, she wants to retain it until it's closed. (I hope no one will treat this as a bug...)
			// 2. The default is to use a different pane and Ctrl is not pressed.
			// 3. The default is to NOT use a different pane and Ctrl IS pressed.
			const someOpenMarkdownLeaf = this.app.workspace.getLeavesOfType('markdown');
			if (havePaneToReuse) {
				// We have an existing pane, that pane still has a view (it was not closed), and the settings say
				// to use a 2nd pane. That's the only case on which we reuse a pane
				this.app.workspace.setActiveLeaf(this.newPaneLeaf);
				leafToUse = this.newPaneLeaf;
			} else if (someOpenMarkdownLeaf.length > 0 && this.settings.markerClickBehavior != 'alwaysNew') {
				// We don't have a pane to reuse but the user wants a new pane and there is currently an open
				// Markdown pane. Let's take control over it and hope it's the right thing to do
				this.app.workspace.setActiveLeaf(someOpenMarkdownLeaf[0]);
				leafToUse = someOpenMarkdownLeaf[0];
				this.newPaneLeaf = leafToUse;
			} else {
				// We need a new pane. We split it the way the settings tell us
				this.newPaneLeaf = this.app.workspace.splitActiveLeaf(this.settings.newPaneSplitDirection || 'horizontal');
				leafToUse = this.newPaneLeaf;
			}
		}
		await leafToUse.openFile(file);
		const editor = this.getEditor();
		if (editor) {
			if (fileLocation) {
				let pos = editor.offsetToPos(fileLocation);
				if (highlight) {
					editor.setSelection({ ch: 0, line: pos.line }, { ch: 1000, line: pos.line });
				} else {
					editor.setCursor(pos);
					editor.refresh();
				}
			}
			editor.focus();
		}

	}

	async goToMarker(marker: FileMarker, useCtrlKeyBehavior: boolean, highlight: boolean) {
		return this.goToFile(marker.file, useCtrlKeyBehavior, marker.fileLocation, highlight);
	}

	getAllTagNames(): string[] {
		let tags: string[] = [];
		const allFiles = this.app.vault.getFiles();
		for (const file of allFiles) {
			const fileCache = this.app.metadataCache.getFileCache(file);
			if (fileCache && fileCache.tags) {
				const fileTagNames = getAllTags(fileCache) || [];
				tags = tags.concat(fileTagNames.filter(tagName => tags.indexOf(tagName) < 0));
			}
		}
		tags = tags.sort();
		return tags;
	}

	getEditor(): Editor {
		let view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view)
			return view.editor;
		return null;
	}

}


