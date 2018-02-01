function $(id) {
    return document.getElementById(id);
}

function $$(query) {
    return document.querySelectorAll(query);
}

let headers = [];
let orig_mutations = undefined;
let mutations = [];
let selected_mutation = undefined;
let blacklist = undefined;
let whitelist = undefined;

function download(url) {
    return new Promise(function (resolve, reject) {
        let request = new XMLHttpRequest();
        request.open('GET', url, true);
        request.onload = function () {
            if (this.status === 200) resolve(this.response);
        };
        request.send();
    })
}

function post_json(url, data, success_handler) {
    let request = new XMLHttpRequest();
    request.open('POST', url, true);
    request.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
    request.onload = function () {
        if (this.status === 200 && success_handler)
            success_handler(JSON.parse(this.response));
    };
    request.send(JSON.stringify(data));
}

function parse_tsv(d) {
    let arr = [];
    let lines = d.split('\n');
    for (let k = 0; k < lines.length; k++) {
        if (lines[k] === '') continue;
        let cols = lines[k].split('\t');
        arr.push(cols);
    }
    return arr;
}

function export_xls() {
    let rows = [headers].concat(mutations.map(each => Object.values(each)));
    let ws = {};
    for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < headers.length; c++) {
            let cell = {v: rows[r][c], t: 's'};
            //if (typeof cell.v ==== 'number') cell.t = 'n';
            ws[XLSX.utils.encode_cell({c: c, r: r})] = cell;
        }
    }
    let range = {s: {c: 0, r: 0}, e: {c: headers.length, r: rows.length}};
    ws['!ref'] = XLSX.utils.encode_range(range);

    function s2ab(s) {
        let buf = new ArrayBuffer(s.length);
        let view = new Uint8Array(buf);
        for (let i = 0; i != s.length; ++i) view[i] = s.charCodeAt(i);
        return buf;
    }

    let wb = {};
    wb.SheetNames = ['Sheet'];
    wb.Sheets = {};
    wb.Sheets['Sheet'] = ws;
    let wbout = XLSX.write(wb, {bookType: 'xlsx', bookSST: true, type: 'binary'});
    let blob = new Blob([s2ab(wbout)], {type: 'application/octet-stream'});
    let a = document.createElement('a');
    a.style.display = 'none';
    document.body.appendChild(a);
    url = window.URL.createObjectURL(blob);
    a.href = url;
    a.download = 'table.xlsx';
    a.click();
    // Firefox fails if revokeObjectURL() called immediately
    setTimeout(() => window.URL.revokeObjectURL(url), 5000);
}

function mutation_signature(cols) {
    return cols.slice(0, 4).join(':')
}

function is_protein_altering(effect) {
    return effect.search(/Missense|rameshift|Stopgain|Stoploss|Splice/) >= 0;
}

function preprocess_data(vcf) {

    // get sample names from header line
    let samples = vcf[0].slice(7);

    // process all remaining lines
    return vcf.slice(1).reduce(function (out, mutation_row) {
        let curr_samples = mutation_row.slice(7);

        // for each mutation_row, get only percent of reads displaying mutation and sample name
        let valid_samples = curr_samples.reduce((valid, smpl, i) => {
            if (smpl.endsWith('*')) valid.push([smpl.slice(0, -2), samples[i]]);
            return valid
        }, []);

        // pre-compute barplot data and sort
        let plot_data = curr_samples.reduce((out, each, i) => {
            let re = /^(\d+\.\d+)\% \((\d+)\).*$/;
            let match = re.exec(each);
            if (match) out.push([parseFloat(match[1]), +match[2], samples[i]]);
            return out
        }, [])
            .sort((a, b) => {
                if (a[0] === b[0] && a[1] < b[1]) return 1;
                if (a[0] < b[0]) return 1;
                return -1
            });

        // build data structure
        for (i = 0; i < valid_samples.length; i++) {
            out.push({
                chrom: mutation_row[0],
                position: mutation_row[1],
                ref: mutation_row[2],
                alt: mutation_row[3],
                gene: mutation_row[4],
                effect: mutation_row[5],
                notes: mutation_row[6],
                sample: valid_samples[i][1],
                freq: valid_samples[i][0],
                signature: mutation_signature(mutation_row),
                plot_data: plot_data
            })
        }
        return out
    }, [])
}

function render_table() {
    if (orig_mutations === undefined || whitelist === undefined ||
        blacklist === undefined) return;

    mutations = orig_mutations.slice(0);   // Make a copy

    // Hide silent mutations if user only wants to see protein altering.
    if ($('show_silent').checked === false) {
        mutations = mutations.filter(m => is_protein_altering(m['effect']));
    }

    // Hide blacklisted mutations if requested by user.
    if ($('show_blacklisted').checked === false) {
        mutations = mutations.filter(m =>
            !(m['signature'] in blacklist));
    }

    let old_table = $('table');
    let new_table = old_table.cloneNode(true);    // Modify outside DOM.
    while (new_table.hasChildNodes())
        new_table.removeChild(new_table.lastChild);

    let thead = document.createElement('thead');
    let thead_tr = document.createElement('tr');
    thead.appendChild(thead_tr);
    for (let c = 0; c < headers.length; c++) {
        let th = document.createElement('th');
        th.appendChild(document.createTextNode(headers[c]));
        thead_tr.appendChild(th);
    }
    new_table.appendChild(thead);

    let tbody = document.createElement('tbody');
    for (let r = 0; r < mutations.length; r++) {
        let tr = document.createElement('tr');
        tr.id = 'r' + r;
        //tr.addEventListener('click', event => event.target.parentNode.classList.toggle('selected'))
        tr.addEventListener('contextmenu', trigger_control)

        for (let c of headers) {
            let td = document.createElement('td');
            let text = mutations[r][c.toLowerCase()];
            td.appendChild(document.createTextNode(text));
            td.title = tooltip(c, mutations[r]);
            tr.appendChild(td);
        }

        // Highlight new mutations in light yellow color.
        let signature = mutations[r]['signature'];
        if (signature in blacklist) tr.classList.add('blacklisted');
        else if (!(signature in whitelist)) tr.classList.add('new');

        tbody.appendChild(tr);
    }
    new_table.appendChild(tbody);
    old_table.parentNode.replaceChild(new_table, old_table);  // Insert to DOM.

    new_table.addEventListener('contextmenu', function (e) {
        let tr = e.target;

        if (e.altKey) {
            mark_seen_letiant(e);
        } else if (e.ctrlKey) {
            blacklist_letiant(e);
        }
        e.preventDefault();
        return false;
    });
}

function tooltip(header, mutation) {
    if (['CHROM', 'POSITION', 'REF', 'ALT'].includes(header.toUpperCase())) {
        return mutation['signature']
    }
    return header.charAt(0) + header.slice(1).toLowerCase() + '\n' + mutation[header.toLowerCase()]
}

function onkeypress(event) {
    switch (event.keyCode) {
        case (27): {
            if (!$('controls').classList.contains('hidden')) clear_control()
            if (!$("barplot_overlay").classList.contains('hidden')) close_barplot()
            break
        }
        default: {
            break
        }
    }
}

function onscroll(event) {
    clear_control();
}

function trigger_control(event) {
    clear_control();

    let div = $('controls');
    div.classList.remove('hidden');

    let windowW = document.documentElement.clientWidth;
    let windowH = document.documentElement.clientHeight;
    let divwidth = event.clientX + div.clientWidth;
    let divheight = event.clientY + div.clientHeight;

    let deltaW = 0;
    if (divwidth > windowW) deltaW = divwidth - windowW;

    let deltaH = 0;
    if (divheight > windowH) deltaH = divheight - windowH;

    let left = (event.clientX - deltaW) + "px";
    let top = (event.clientY - deltaH) + "px";
    div.style.left = left;
    div.style.top = top;

    event.target.parentNode.classList.add('selected');
    $('info').innerHTML = event.target.parentNode.rowIndex - 1;
    return false
}

function trigger_igv(event) {

    let row = parseInt($('info').innerHTML);

    let locus = mutations[row]['chrom'] + ':' + mutations[row]['position'];
    let bam_file = mutations[row]['sample'] + '.bam';
    let request = new XMLHttpRequest();
    request.open('GET', 'http://localhost:60151/load?file={{bam_root}}' + bam_file + '&genome=hg38&locus=' + locus + '&merge=false', true);
    request.send();
    event.preventDefault();
}

function get_row(event) {

    let target_element = event.target;

    // understand entry point
    if (target_element.nodeName === 'A') {
        let idx = parseInt($('info').innerHTML);
        target_element = $('r' + idx);
    } else if (target_element.nodeName === 'TD') {
        while (target_element.nodeName != 'TR') target_element = target_element.parentNode;
    }

    clear_control();
    return target_element
}

function mark_seen_letiant(event) {

    // Update DOM and get data
    let tr = get_row(event);
    let signature = mutations[tr.rowIndex - 1]['signature'];
    tr.classList.toggle('new');

    // Update whitelist on server
    let d = {file: '{{whitelist}}', updates: {}};
    d['updates'][signature] = !tr.classList.contains('new');
    post_json('/update_mutation_blacklist', d);

    // Update local whitelist
    if (tr.classList.contains('new')) delete whitelist[signature];
    else whitelist[signature] = true;
}

function blacklist_letiant(event) {

    // get DOM element and data
    let tr = get_row(event);
    let signature = mutations[tr.rowIndex - 1]['signature'];

    // get current status and update DOM
    let now_blacklisted = !tr.classList.contains('blacklisted');
    tr.classList.toggle('blacklisted');

    // Update local blacklist
    if (now_blacklisted) blacklist[signature] = true;
    else delete blacklist[signature];

    // Update blacklist on server
    let d = {file: '{{blacklist}}', updates: {}};
    d['updates'][signature] = now_blacklisted;
    post_json('/update_mutation_blacklist', d);
}

function clear_control() {

    // hide control box if necessary
    if (!$('controls').classList.contains('hidden')) {
        $('controls').classList.add('hidden');
        $('info').innerHTML = '';
    }

    let tr_list = $$('tr.selected');
    if (tr_list[0]) tr_list[0].classList.remove('selected');
}

function init(resolved) {

    // assign resolved values
    let VCF = resolved[0];
    let Whitelist = resolved[1];
    let Blacklist = resolved[2];

    // parse data
    headers = ['CHROM', 'POSITION', 'REF', 'ALT', 'GENE', 'EFFECT', 'NOTES', 'SAMPLE', 'FREQ'];
    orig_mutations = preprocess_data(VCF);

    // parse whitelist
    whitelist = {};
    let lines = Whitelist.split('\n');
    for (let k = 0; k < lines.length; k++) {
        if (lines[k] === '') continue;
        let cols = lines[k].split('\t');
        let signature = mutation_signature(cols);
        whitelist[signature] = true;
    }

    // parse blacklist
    blacklist = {};
    let lines = Blacklist.split('\n');
    for (let k = 0; k < lines.length; k++) {
        if (lines[k] === '') continue;
        let cols = lines[k].split('\t');
        let signature = mutation_signature(cols);
        blacklist[signature] = true;
    }

    // render table
    render_table();
}

function show_barplot() {

    if ($('barplot_overlay').classList.contains('hidden')) $('barplot_overlay').classList.remove('hidden');
    if (!$('barplot_overlay').classList.contains('fade-in')) $('barplot_overlay').classList.add('fade-in');

    let container = $('barplot-container'),
        width = container.clientWidth;
    height = window.innerHeight - $('close_barplot').clientHeight;
    let height1 = Math.floor(height * 0.2);
    let height2 = Math.floor(height * 0.6);

    let svg1 = d3.select(container).append('svg')
        .attr('id', 'top-barplot')
        .attr('width', width)
        .attr('height', height1)
        .node();

    let svg2 = d3.select(container).append('svg')
        .attr('id', 'bottom-barplot')
        .attr('width', width)
        .attr('height', height2)
        .node();

    if (selected_mutation) {
        let data = selected_mutation['plot_data'];
    } else {
        let idx = parseInt($('info').innerHTML);
        let data = mutations[idx]['plot_data'];
        selected_mutation = mutations[idx];
    }

    init_top_barplot(svg1, data);
    init_bottom_barplot(svg2, data);

    container.appendChild(svg1);
    container.appendChild(svg2);
}

function close_barplot() {
    d3.select('.overlay-content').selectAll('svg').remove();
    $('barplot_overlay').classList.add('hidden');
    $('barplot_overlay').classList.remove('fade-in');
    selected_mutation = undefined;
}

function highlight(target_sample, toggle_highlight) {

    // toggle barplot-selected class
    let target_array = $$('.' + target_sample);
    target_array.forEach(each => {
        d3.select(each).classed('barplot-selected', toggle_highlight)
    })

    // // update info text
    // let report_area = d3.select($('svg-report-area'))

    // // remove previous informations
    // report_area.select('text').remove()
    // report_area.select('rect').remove()

    // // add new info if mouseenter
    // if (toggle_highlight) {

    // 	// filter table row data
    // 	target_data = selected_mutation.plot_data.filter(each => each[2].toLowerCase() ==== target_sample)[0]

    // 	let row1 = 'Sample: ' + target_sample.toUpperCase();
    // 	let row2 = 'Reads: ' + target_data[1];
    // 	let row3
    // 	if (target_data[0] != 0) {
    // 		let mut_reads = Math.ceil(target_data[1] * (target_data[0] / 100));
    // 		row3 = 'Mutated allele: ' + target_data[0] + '% (' + mut_reads + ' read'+ (mut_reads > 1 ? 's' : '') +')';
    // 	} else { row3 = ''; }

    // 	// add background
    // 	report_area.append('rect')
    // 	.attr('width', () => {
    // 		let x_axis_BB = $$('#bottom-barplot .axis--x')[0].getBoundingClientRect();
    // 		return Math.floor(x_axis_BB['width'] * .44)
    // 	})
    // 	.attr('height','40')
    // 	.attr('fill','salmon')

    // 	// add text
    // 	let text_el = report_area.append('text')
    // 		.attr('text-anchor','end')
    // 		.attr('x', function () {
    // 			let x_axis_BB = $$('#bottom-barplot .axis--x')[0].getBBox();
    // 			console.log(x_axis_BB);
    // 			return Math.floor(x_axis_BB['x'])
    // 	})
    // 		.attr('y', '4')

    // 	text_el.append('tspan')
    // 	.attr('x', '1')
    // 	.attr('y', '1')
    // 	.attr('alignment-baseline', 'hanging')
    // 	.text(row1)

    // 	text_el.append('tspan')
    // 	.attr('x', '1')
    // 	.attr('y', '16')
    // 	.attr('alignment-baseline', 'middle')
    // 	.text(row2)

    // 	if (target_data[0] != 0) {
    // 		text_el.append('tspan')
    // 		.attr('x', '1')
    // 		.attr('y', '32')
    // 		.attr('alignment-baseline', 'ideographic')
    // 		.text(row3)
    // 	}
    // }

}

function init_top_barplot(element) {

    // process data
    let data = selected_mutation.plot_data.map(x => [x[0] / 100, x[2]]);

    // define margins
    let margin = {top: 20, right: 20, bottom: 20, left: 80};

    // set options
    let options = {
        margin: margin,
        nticks: 5,
        ticks_format: '.2p',
        y_label: 'Mut. allele %',
        show_x_label: false,
        add_brush: true,
        report_area: false
    };

    // init
    let barplot = init_barplot(element, data, options);
    let g = barplot.g;
    let x = barplot.x_axis;
    let y = barplot.y_axis;
    let height = barplot.plot_height;

    // draw bars
    g.selectAll(".bar")
        .data(data)
        .enter().append("rect")
        .attr("class", (d) => "bar " + d[1].toLowerCase())
        .attr('fill', '#A9A9A9')
        .attr("x", d => x(d[1]))
        .attr("y", d => y(d[0]))
        .attr("width", x.bandwidth())
        .attr("height", d => y(0) < y(d[0]) ? 0 : Math.abs(height - y(d[0])))
        .on("mouseenter", (event) => {
            let target_sample = event[1].toLowerCase();
            highlight(target_sample, true)
        })
        .on('mouseleave', (event) => {
            let target_sample = event[1].toLowerCase();
            highlight(target_sample, false)
        });
}

function init_bottom_barplot(element) {

    // map input data to arrays for init and display
    let rawdata = selected_mutation.plot_data.map(x => [x[1], x[2]]);
    let processeddata = selected_mutation.plot_data.map(x => {
        let mut_fraction = Math.ceil(x[1] * (x[0] / 100));
        return [x[1] - mut_fraction, mut_fraction, x[2]]
    });

    // compute margins
    let margin = {
        top: 20, right: 20,
        bottom: $('bottom-barplot').clientHeight * 0.4,
        left: 80
    };

    // set plot options
    let options = {
        margin: margin,
        nticks: 10,
        ticks_format: '.2g',
        y_label: 'Reads',
        show_x_label: true,
        add_brush: false,
        report_area: true
    };

    // init
    let barplot = init_barplot(element, rawdata, options);
    let g = barplot.g;
    let x = barplot.x_axis;
    let y = barplot.y_axis;
    let z = d3.scaleOrdinal().range(["black", "#A9A9A9"]);
    let height = barplot.plot_height;
    let keys = [1, 0];

    // draw stacked bars
    g.append("g")
        .selectAll("g")
        .data(d3.stack().keys(keys)(processeddata))
        .enter().append("g")
        .attr("fill", d => z(d.key))
        .selectAll("rect")
        .data(d => d)
        .enter().append("rect")
        .attr("x", d => x(d.data[2]))
        .attr("y", d => y(d[1]))
        .attr("height", (d) => y(d[0]) - y(d[1]))
        .attr("width", x.bandwidth())
        .attr("class", d => "bar " + d.data[2].toLowerCase())
        .on("mouseenter", (event) => {
            let target_sample = event.data[2].toLowerCase();
            highlight(target_sample, true)
        })
        .on('mouseleave', (event) => {
            let target_sample = event.data[2].toLowerCase();
            highlight(target_sample, false)
        });

}

function init_barplot(element, data, options) {

    // simple input parsin (NO ERROR CHECK)
    let margin = options.margin,
        nticks = options.nticks,
        ticks_format = options.ticks_format,
        y_label = options.y_label;
    x_label = options.show_x_label,
        add_brush = options.add_brush,
        add_display_area = options.report_area;

    // get element, measure dimensions
    let svg = d3.select(element),
        width = +svg.attr("width") - margin.left - margin.right,
        height = +svg.attr("height") - margin.top - margin.bottom;

    // define scales
    let x = d3.scaleBand().rangeRound([0, width]),
        y = d3.scaleLinear().rangeRound([height, 0]);

    // define domains from data
    let x0 = data.map(x => x[1]);
    let y0 = [0, d3.max(data.map(x => x[0]))];

    // apply domains to scales
    x.domain(x0);
    y.domain(y0).nice();

    // add container
    let g = svg.append("g")
        .attr("transform", "translate(" + margin.left + "," + margin.top + ")");

    // draw x-axis
    g.append("g")
        .attr("class", "axis axis--x")
        .attr("transform", "translate(0," + height + ")")
        .call(d3.axisBottom(x))
        .selectAll("text")
        .style("display", () => x_label ? "block" : "none")
        .style("text-anchor", "end")
        .style("fill", "#A9A9A9")
        .attr("dx", "-.8em")
        .attr("dy", ".15em")
        .attr("transform", "rotate(-60)")
        .attr('class', (d) => "plot-label " + d[1].toLowerCase())
        .on("mouseenter", (event) => {
            let target_sample = event.toLowerCase();
            highlight(target_sample, true)
        })
        .on("mouseleave", (event) => {
            let target_sample = event.toLowerCase();
            highlight(target_sample, false)
        });

    // append special classes to x ticks
    let ticks = d3.selectAll(".axis--x .tick text");
    ticks.attr("class", d => d.toLowerCase());

    // define yAxis object
    let yAxis = d3.axisLeft(y)
        .ticks(nticks)
        .tickFormat(d3.format(ticks_format));

    // add y gridline
    g.append("g")
        .attr("class", "grid grid--y")
        .call(d3.axisLeft(y)
            .ticks(nticks)
            .tickSize(-width)
            .tickFormat(""));

    // draw axis with label
    let yAxisEl = g.append("g")
        .attr("class", "axis axis--y")
        .call(yAxis);

    yAxisEl.append("text")
        .attr('fill', 'black')
        .attr('font-size', '12')
        .attr("transform", "rotate(-90)")
        .attr("y", 0 - margin.left + 10)
        .attr("x", -height / 2)
        .attr("dy", "1em")
        .attr("text-anchor", "middle")
        .text(y_label);

    // add y brush
    if (add_brush) {

        // define brushend listener
        let onbrushend = () => {
            if (d3.event.sourceEvent !== null && typeof d3.event.sourceEvent.target !== "function") {
                let extent = d3.event.selection;
                if (extent) { // zooming
                    let axcoord = extent.map(y.invert, y).sort();
                    y.domain(axcoord).nice()
                } else {
                    y.domain(y0);
                }

                let t = svg.transition().duration(750);

                svg.select(".grid--y").transition(t)
                    .call(d3.axisLeft(y)
                        .ticks(nticks)
                        .tickSize(-width)
                        .tickFormat(""));

                svg.select(".axis--y").transition(t).call(yAxis);

                svg.selectAll(".bar").transition(t)
                    .attr("x", d => x(d[1]))
                    .attr("y", (d) => y(d[0]))
                    .attr("width", x.bandwidth())
                    .attr("height", d => {
                        if (y(0) < y(d[0])) return 0;
                        return height - y(d[0])
                    });

                svg.select(".brush").call(brushFn.move, null);

            }
        };

        // define brush and attach listener
        let brushFn = d3.brushY()
            .extent([[0, y(y0[1])], [width, y(0)]])
            .on("end", onbrushend);

        // append brush to the plot
        g.append("g").attr("class", "brush").call(brushFn);
    }

    if (add_display_area) {
        g.append("g")
            .attr('id', 'svg-report-area')
            .attr('font-size', '12')
            .attr('transform', 'translate(' + Math.floor(width * .55) + ', ' + y(y0[1]) + ')')

    }

    return {g: g, x_axis: x, y_axis: y, plot_height: height}
}

function onresize() {
    if (!$('barplot_overlay').classList.contains('hidden')) {
        d3.select('.overlay-content').selectAll('svg').remove();
        show_barplot()
    }
}

(function main() {
    console.log("load script success")

    Promise.all([
        download('{{data}}').then(parse_tsv),
        download('{{whitelist}}'), download('{{blacklist}}')])
        .then(init);

    window.addEventListener('scroll', onscroll);
    window.addEventListener('resize', onresize);
    document.addEventListener('keydown', onkeypress);
    document.addEventListener('click', clear_control);
    $('show_silent').addEventListener('click', render_table);
    $('show_blacklisted').addEventListener('click', render_table);
    $('export_xls').addEventListener('click', export_xls);
    $('igv_button').addEventListener('click', trigger_igv);
    $('blacklist_button').addEventListener('click', blacklist_letiant);
    $('seen_button').addEventListener('click', mark_seen_letiant);
    $('bplot_button').addEventListener('click', show_barplot);

})();