/**
 * CitationNetworkVisualization — D3.js v7 force-directed network.
 *
 * Expects node objects with: { id, title, authors[], journal, year,
 *   research_area, degree, cluster_id, degree_centrality, betweenness_approx }
 * Expects edge objects with: { source, target, weight, type }
 * Expects cluster objects with: { id, size, topic, key_authors[], density }
 */
class CitationNetworkVisualization {
    constructor(containerId, options = {}) {
        this.containerId = containerId;
        this.container = d3.select(`#${containerId}`);

        this.config = {
            width: options.width || 900,
            height: options.height || 560,
            nodeRadius: options.nodeRadius || 7,
            linkDistance: options.linkDistance || 90,
            chargeStrength: options.chargeStrength || -250,
            zoomExtent: options.zoomExtent || [0.1, 8],
            colors: options.colors || this._defaultColors(),
        };

        this._rawData = null;
        this._viewData = null;
        this._simulation = null;
        this._nodeSelection = null;
        this._linkSelection = null;
        this._labelSelection = null;
        this._showLabels = false;
        this._currentFilters = {};
        this._selectedNodeId = null;

        this._init();
    }

    // ── Initialisation ────────────────────────────────────────────────────────

    _init() {
        this.container.selectAll('*').remove();

        this._svg = this.container
            .append('svg')
            .attr('width', this.config.width)
            .attr('height', this.config.height)
            .style('background', '#fafafa')
            .style('border', '1px solid #e2e8f0')
            .style('border-radius', '.5rem')
            .style('display', 'block')
            .style('width', '100%');

        this._zoom = d3.zoom()
            .scaleExtent(this.config.zoomExtent)
            .on('zoom', (e) => this._g.attr('transform', e.transform));
        this._svg.call(this._zoom);

        this._g = this._svg.append('g');
        this._gLinks = this._g.append('g').attr('class', 'nv-links');
        this._gNodes = this._g.append('g').attr('class', 'nv-nodes');
        this._gLabels = this._g.append('g').attr('class', 'nv-labels');

        this._tip = d3.select('body').append('div')
            .attr('class', 'nv-tooltip')
            .style('position', 'absolute')
            .style('padding', '8px 12px')
            .style('background', 'rgba(26,32,44,.9)')
            .style('color', '#fff')
            .style('border-radius', '.4rem')
            .style('font-size', '12px')
            .style('pointer-events', 'none')
            .style('max-width', '260px')
            .style('line-height', '1.5')
            .style('opacity', 0)
            .style('z-index', 9999);

        this._simulation = d3.forceSimulation()
            .force('link', d3.forceLink().id(d => d.id)
                .distance(this.config.linkDistance)
                .strength(0.5))
            .force('charge', d3.forceManyBody().strength(this.config.chargeStrength))
            .force('center', d3.forceCenter(this.config.width / 2, this.config.height / 2))
            .force('collide', d3.forceCollide().radius(d => this._nodeR(d) + 3))
            .on('tick', () => this._tick());
    }

    // ── Public API ────────────────────────────────────────────────────────────

    loadData(data) {
        this._rawData = data;
        this._viewData = this._prepare(data);
        this._render();
        this._emitStats();
    }

    applyFilters(filters) {
        this._currentFilters = { ...filters };
        if (!this._rawData) return;
        this._viewData = this._prepare(this._rawData, filters);
        this._render();
        this._emitStats();
    }

    searchNodes(query) {
        if (!this._nodeSelection) return [];
        if (!query) { this.clearSearch(); return []; }
        const q = query.toLowerCase();
        const hits = (this._viewData?.nodes || []).filter(n =>
            (n.title || '').toLowerCase().includes(q) ||
            (n.authors || []).some(a => a.toLowerCase().includes(q)) ||
            (n.journal || '').toLowerCase().includes(q)
        );
        const hitIds = new Set(hits.map(h => h.id));
        this._nodeSelection
            .attr('opacity', d => hitIds.has(d.id) ? 1 : 0.15)
            .attr('stroke', d => hitIds.has(d.id) ? '#38a169' : '#fff')
            .attr('stroke-width', d => hitIds.has(d.id) ? 2.5 : 1.5);
        return hits;
    }

    clearSearch() {
        if (!this._nodeSelection) return;
        this._nodeSelection
            .attr('opacity', 1)
            .attr('stroke', '#fff')
            .attr('stroke-width', 1.5);
    }

    updateLayout(type) {
        if (!this._viewData) return;
        const nodes = this._viewData.nodes;
        const W = this.config.width, H = this.config.height;

        // Release all fixed positions first
        nodes.forEach(n => { n.fx = null; n.fy = null; });

        if (type === 'circular') {
            const r = Math.min(W, H) / 2 - 60;
            nodes.forEach((n, i) => {
                const a = (i / nodes.length) * 2 * Math.PI;
                n.fx = W / 2 + r * Math.cos(a);
                n.fy = H / 2 + r * Math.sin(a);
            });
            this._simulation.alpha(0.3).restart();
        } else if (type === 'community') {
            const groups = {};
            nodes.forEach(n => {
                const g = n.cluster_id ?? 'none';
                (groups[g] = groups[g] || []).push(n);
            });
            const keys = Object.keys(groups);
            const cols = Math.ceil(Math.sqrt(keys.length));
            const cw = W / (cols || 1), ch = H / Math.ceil(keys.length / (cols || 1));
            keys.forEach((k, gi) => {
                const cx = (gi % cols + 0.5) * cw;
                const cy = (Math.floor(gi / cols) + 0.5) * ch;
                const members = groups[k];
                members.forEach((n, ni) => {
                    const a = (ni / members.length) * 2 * Math.PI;
                    const ri = Math.min(cw, ch) * 0.35;
                    n.fx = cx + ri * Math.cos(a);
                    n.fy = cy + ri * Math.sin(a);
                });
            });
            this._simulation.alpha(0.3).restart();
        } else {
            // force — just release and reheat
            this._simulation
                .force('center', d3.forceCenter(W / 2, H / 2))
                .alpha(1).restart();
        }
    }

    toggleLabels() {
        this._showLabels = !this._showLabels;
        if (!this._showLabels) {
            this._gLabels.selectAll('*').remove();
            this._labelSelection = null;
        } else {
            this._renderLabels();
        }
    }

    resetView() {
        this._svg.transition().duration(600)
            .call(this._zoom.transform, d3.zoomIdentity);
    }

    fitToContent() {
        const bounds = this._g.node().getBBox();
        if (!bounds.width || !bounds.height) return;
        const W = this.config.width, H = this.config.height;
        const scale = 0.9 / Math.max(bounds.width / W, bounds.height / H);
        const tx = W / 2 - scale * (bounds.x + bounds.width / 2);
        const ty = H / 2 - scale * (bounds.y + bounds.height / 2);
        this._svg.transition().duration(600)
            .call(this._zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    }

    exportJSON() {
        if (!this._viewData) return;
        const blob = new Blob(
            [JSON.stringify({ nodes: this._viewData.nodes, edges: this._viewData.links,
                clusters: this._viewData.clusters, filters: this._currentFilters,
                exported_at: new Date().toISOString() }, null, 2)],
            { type: 'application/json' }
        );
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `citation-network-${Date.now()}.json`;
        a.click();
    }

    destroy() {
        this._simulation?.stop();
        this._tip?.remove();
        this.container.selectAll('*').remove();
    }

    // ── Data preparation ──────────────────────────────────────────────────────

    _prepare(data, filters = {}) {
        let nodes = (data.nodes || []).map(n => ({ ...n }));
        let links = (data.edges || []).map(e => ({ ...e }));

        if (filters.research_areas?.length) {
            const areas = new Set(filters.research_areas);
            nodes = nodes.filter(n => areas.has(n.research_area));
        }
        if (filters.year_min || filters.year_max) {
            nodes = nodes.filter(n => {
                const y = n.year || 0;
                if (filters.year_min && y && y < filters.year_min) return false;
                if (filters.year_max && y && y > filters.year_max) return false;
                return true;
            });
        }
        if (filters.cluster_ids?.length) {
            const ids = new Set(filters.cluster_ids.map(Number));
            nodes = nodes.filter(n => ids.has(n.cluster_id));
        }

        const nodeSet = new Set(nodes.map(n => n.id));
        links = links.filter(e => {
            const s = typeof e.source === 'object' ? e.source.id : e.source;
            const t = typeof e.target === 'object' ? e.target.id : e.target;
            return nodeSet.has(s) && nodeSet.has(t);
        });

        return { nodes, links, clusters: data.clusters || [], metrics: data.metrics || {} };
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    _render() {
        if (!this._viewData) return;
        this._renderLinks();
        this._renderNodes();
        if (this._showLabels) this._renderLabels();
        this._simulation
            .nodes(this._viewData.nodes)
            .force('link').links(this._viewData.links);
        this._simulation.alpha(1).restart();
    }

    _renderLinks() {
        const data = this._viewData.links;
        const sel = this._gLinks.selectAll('line').data(data, d => {
            const s = typeof d.source === 'object' ? d.source.id : d.source;
            const t = typeof d.target === 'object' ? d.target.id : d.target;
            return `${s}-${t}`;
        });
        sel.exit().remove();
        const enter = sel.enter().append('line');
        this._linkSelection = enter.merge(sel)
            .attr('stroke', '#c4b5fd')
            .attr('stroke-opacity', 0.55)
            .attr('stroke-width', d => Math.max(1, (d.weight || 0.25) * 3))
            .style('cursor', 'pointer')
            .on('mouseover', (ev, d) => {
                d3.select(ev.target).attr('stroke', '#6b46c1').attr('stroke-opacity', 1);
                this._showTip(ev, `<strong>Connection</strong><br>Type: ${d.type || '—'}<br>Weight: ${(d.weight||0).toFixed(3)}`);
            })
            .on('mouseout', (ev) => {
                d3.select(ev.target).attr('stroke', '#c4b5fd').attr('stroke-opacity', 0.55);
                this._hideTip();
            });
    }

    _renderNodes() {
        const data = this._viewData.nodes;
        const drag = d3.drag()
            .on('start', (ev, d) => { if (!ev.active) this._simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
            .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
            .on('end', (ev, d) => { if (!ev.active) this._simulation.alphaTarget(0); d.fx = null; d.fy = null; });

        const sel = this._gNodes.selectAll('circle').data(data, d => d.id);
        sel.exit().remove();
        const enter = sel.enter().append('circle')
            .call(drag)
            .on('mouseover', (ev, d) => { this._onNodeOver(ev, d); })
            .on('mouseout', () => { this._onNodeOut(); })
            .on('click', (ev, d) => { this._onNodeClick(ev, d); });

        this._nodeSelection = enter.merge(sel)
            .attr('r', d => this._nodeR(d))
            .attr('fill', d => this._nodeColor(d))
            .attr('stroke', '#fff')
            .attr('stroke-width', 1.5)
            .style('cursor', 'pointer');
    }

    _renderLabels() {
        if (!this._viewData) return;
        const data = this._viewData.nodes;
        const sel = this._gLabels.selectAll('text').data(data, d => d.id);
        sel.exit().remove();
        const enter = sel.enter().append('text')
            .style('font-size', '9px')
            .style('fill', '#4a5568')
            .style('pointer-events', 'none')
            .attr('text-anchor', 'middle');
        this._labelSelection = enter.merge(sel)
            .text(d => (d.title || d.id).slice(0, 22));
    }

    _tick() {
        const W = this.config.width, H = this.config.height;
        if (this._linkSelection) {
            this._linkSelection
                .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
                .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        }
        if (this._nodeSelection) {
            this._nodeSelection
                .attr('cx', d => d.x = Math.max(20, Math.min(W - 20, d.x)))
                .attr('cy', d => d.y = Math.max(20, Math.min(H - 20, d.y)));
        }
        if (this._labelSelection) {
            this._labelSelection
                .attr('x', d => d.x)
                .attr('y', d => d.y - this._nodeR(d) - 3);
        }
    }

    // ── Interaction ───────────────────────────────────────────────────────────

    _onNodeOver(ev, d) {
        // Dim non-neighbours
        const neighbourSet = new Set([d.id]);
        (this._viewData?.links || []).forEach(e => {
            const s = typeof e.source === 'object' ? e.source.id : e.source;
            const t = typeof e.target === 'object' ? e.target.id : e.target;
            if (s === d.id) neighbourSet.add(t);
            else if (t === d.id) neighbourSet.add(s);
        });
        this._nodeSelection?.attr('opacity', n => neighbourSet.has(n.id) ? 1 : 0.2);
        this._linkSelection
            ?.attr('stroke', e => {
                const s = typeof e.source === 'object' ? e.source.id : e.source;
                const t = typeof e.target === 'object' ? e.target.id : e.target;
                return (s === d.id || t === d.id) ? '#6b46c1' : '#c4b5fd';
            })
            .attr('stroke-opacity', e => {
                const s = typeof e.source === 'object' ? e.source.id : e.source;
                const t = typeof e.target === 'object' ? e.target.id : e.target;
                return (s === d.id || t === d.id) ? 1 : 0.2;
            });

        const authLine = (d.authors || []).slice(0, 3).join(', ') + (d.authors?.length > 3 ? ' et al.' : '');
        this._showTip(ev,
            `<strong style="font-size:13px">${(d.title || '—').slice(0, 80)}</strong><br>` +
            `${authLine}<br>` +
            `<em>${d.journal || '—'}</em> ${d.year || ''}<br>` +
            `Cluster ${d.cluster_id ?? '—'} · degree ${d.degree || 0}`
        );
    }

    _onNodeOut() {
        this._nodeSelection?.attr('opacity', 1);
        this._linkSelection?.attr('stroke', '#c4b5fd').attr('stroke-opacity', 0.55);
        this._hideTip();
    }

    _onNodeClick(ev, d) {
        ev.stopPropagation();
        this._selectedNodeId = (this._selectedNodeId === d.id) ? null : d.id;
        this._nodeSelection
            ?.attr('stroke', n => n.id === this._selectedNodeId ? '#6b46c1' : '#fff')
            .attr('stroke-width', n => n.id === this._selectedNodeId ? 3 : 1.5);
        document.dispatchEvent(new CustomEvent('nv:nodeClick', { detail: d }));
    }

    // ── Tooltip ───────────────────────────────────────────────────────────────

    _showTip(ev, html) {
        this._tip.style('opacity', 1).html(html)
            .style('left', (ev.pageX + 12) + 'px')
            .style('top', (ev.pageY - 8) + 'px');
    }

    _hideTip() { this._tip.style('opacity', 0); }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _nodeR(d) {
        const base = this.config.nodeRadius;
        const boost = Math.min((d.degree || 0) * 0.4, base * 1.5);
        return base + boost;
    }

    _nodeColor(d) {
        const pal = this.config.colors.clusters;
        if (d.cluster_id !== null && d.cluster_id !== undefined) {
            return pal[d.cluster_id % pal.length];
        }
        return this.config.colors.default;
    }

    _defaultColors() {
        return {
            default: '#a0aec0',
            clusters: ['#6b46c1','#3182ce','#38a169','#dd6b20','#e53e3e',
                       '#319795','#d69e2e','#805ad5','#e83e8c','#2b6cb0'],
        };
    }

    _emitStats() {
        if (!this._viewData) return;
        document.dispatchEvent(new CustomEvent('nv:stats', {
            detail: {
                nodes: this._viewData.nodes.length,
                edges: this._viewData.links.length,
                clusters: this._viewData.clusters.length,
                metrics: this._viewData.metrics,
            }
        }));
    }
}

window.CitationNetworkVisualization = CitationNetworkVisualization;
