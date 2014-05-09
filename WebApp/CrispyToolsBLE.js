(function Viz() {
'use strict'
///////////////////////////////////////////////////////////////////////////////
// live viewer of BLE scanner ouput.  BLE scanner logs to firebase ThingStreams
///////////////////////////////////////////////////////////////////////////////

// human readable version of this script
var scriptVersion = 'CrispyToolsBLE.js v2014-05-02a'

///////////////////////////////////////////////////////////////////////////////
// firebase references
///////////////////////////////////////////////////////////////////////////////
var rootRef = 'https://ibeacon-sequence-tsns.firebaseio.com/' // URL of the firebase
var refThingstreamServer = 'https://crispy-thingstream-name-server.firebaseio.com' // URL of the firebase
var tsVizD3Sel = d3.select('#TSViz') // d3 selection that holds all visualizations
var logD3Sel = d3.select('#TSLog') // d3 selection for log messages
var d3SelButtons // DOM element for Buttons
var d3SelThingVizs // DOM element for all ThingStream Visualizations
var TEXT_HEIGHT = 16 // default guess, this is updated later in page load
var estimatedServerTimeOffset = 0 // milliseconds
var serverTimeOffsetRef = new Firebase( [rootRef, '.info', 'serverTimeOffset'] .join('/') )
var refAllStreamInfoByUuid = new Firebase(fbUrl([
		refThingstreamServer,	'allStreamInfoByUuid'
	]))
var refAllThingInfoByUuid = new Firebase(fbUrl([
		refThingstreamServer,	'allThingInfoByUuid'
	]))
var allVizRefArraysByThingUuid = {} // save refs globally for cleanup when removed
var allVizd3SelArraysByThingUuid = {} // save dom elements globally for cleanup when removed
var debugLogVizInfo = { // TODO: get these *Info objects from cloud Viz name-server
		limit : 50,
		title : 'Debug Log from UART A (imp pin 7)',
		VizName : 'debugLog',
		VizTitle : 'debugLogTitle'
	}
var debugLogVizInfoB = { // TODO: get these *Info objects from cloud Viz name-server
		limit : 50,
		title : 'Debug Log from UART B (imp pin 9)',
		VizName : 'debugLogB',
		VizTitle : 'debugLogBTitle'
	}

function serverNow() {
	return new Date().getTime() + estimatedServerTimeOffset
}

function fbUrl(pathArray) { // helper to construct URL from list of path parts
	return pathArray.join('/')
}

function compareKey(keyName, sortOrder, returnObject) {
	// sortOrder is >0 for ascending, <0 for descending (reversed), ==0 for no change defaults to 1
	if (returnObject) {
		returnObject.less = 0
		returnObject.more = 0
		returnObject.equal = 0
	}
	return function (d1, d2) {
		var result = (sortOrder || 1) > 0 ? d1[keyName] - d2[keyName] : sortOrder < 0 ? d2[keyName] - d1[keyName] : 0
		if (returnObject) {
			result < 0 ? returnObject.less++
				: result > 0 ? returnObject.more++
					: returnObject.equal++  
		}
		return result
	}
}

function millisToLocalTimeStringFriendly(t) { // helper
	var s,
		time,
		months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

	time = new Date(parseInt(String(t).substr(0,13),10))
	s = //time.getFullYear() + 
		//'-' + 
		// String('00' + (time.getMonth() + 1)).slice(-2) + 
		months[time.getMonth()] + 
		'-' + String('00' + time.getDate()).slice(-2) + 
		' at ' + String('00' + time.getHours()).slice(-2) + 
		':' + String('00' + time.getMinutes()).slice(-2) + 
		':' + String('00' + time.getSeconds()).slice(-2) + 
		// '.' + String('000' + t % 1000).slice(-3) + 
		'.' + String(t).substr(10,6)
		// ' (' + t + ')'
	return s    
}

function appendThingName(d3Selection) {
	d3Selection
		.append('div')
		.attr({
			name : 'thingName',
			class : 'panel-heading text-center'
		})	
}

function appendList(d3Selection, info) {
	var sel
	sel = d3Selection
		.append('div')
		.attr({
			class : 'col-6'
		})
	sel
		.append('div')
		.attr({
			name : info.VizTitle,
			class : 'col-6 text-center'
		})
	sel
		.append('div')		
		.attr({
			name : info.VizName,
			class : 'col-6',
			style : 'resize:vertical;overflow:auto;height:248px'
		})
}

function appendDebugLog(d3Selection) { // use with d3.call()
	appendList(d3Selection, debugLogVizInfo)
	d3Selection.select('[name=' + debugLogVizInfo.VizTitle + ']')
		.text(debugLogVizInfo.title)	
}

function appendDebugLogB(d3Selection) { // use with d3.call()
	appendList(d3Selection, debugLogVizInfoB)
	d3Selection.select('[name=' + debugLogVizInfoB.VizTitle + ']')
		.text(debugLogVizInfoB.title)	
}

function redrawList(d3Data, textFromD3Data) {
	var d
	var sessions

	d = this.d3SelThing
		.selectAll('[name=' + this.info.VizName + ']')

	sessions = d
		.selectAll('div')
		.data(
			d3Data,
			function (d) {
				return d.timeSessionStart
			}
		)

	sessions.enter()
		.append('div')
		.attr({
			style : "font:'Lucida Console';font-size:9pt;background:#000;color:#0cd"
		})
		.text(textFromD3Data)

	sessions
		.sort(compareKey('timeSessionStart'))

	sessions.exit()
		.remove()

	d.node().scrollTop = d.node().scrollHeight
}

function redrawDebugLog(d3Data) { // called on data change
	redrawList.call(this, d3Data, function (d) {
			return millisToLocalTimeStringFriendly(d.timeSessionStart) + '> ' + d.string
		})
} //redrawDebugLog()

function removeVizByThingUuid(thingUuid) {
	// cancel all firebase callbacks that addVizFromThingUuid() created
	for (var i = allVizRefArraysByThingUuid[thingUuid].length - 1; i >= 0; i--) {
		allVizRefArraysByThingUuid[thingUuid][i].off()
	}
	delete allVizRefArraysByThingUuid[thingUuid]
	// remove all dom elements that addVizFromThingUuid() created
	for (var i = allVizd3SelArraysByThingUuid[thingUuid].length - 1; i >= 0; i--) {
		allVizd3SelArraysByThingUuid[thingUuid][i].remove()
	}
	delete allVizd3SelArraysByThingUuid[thingUuid]
}

function convertFBSnapToD3Data(snap) {
	var d3Data
	var d3Data2
	var v = snap.val()
	var keyArray
	var startTime

	// d3Data = []
	// startTime = new Date()
	// for(var timeSessionStart in v) { // convert JSON to array for use by d3
	// 	var obj = {}
	// 	obj.string = v[timeSessionStart]
	// 	// move timestamp form key name into object then push on the array
	// 	obj.timeSessionStart = timeSessionStart // allready in absolute milliseconds
	// 	d3Data.push(obj)
	// }
	// console.log('for(var ... in... ) = ' + (new Date() - startTime))

	d3Data2 = []
	// startTime = new Date()
	keyArray = Object.keys(v)
	for (var i = 0, l = keyArray.length; i < l; i++) {
		var t = keyArray[i]
		d3Data2.push({
			string : v[t],
			timeSessionStart : t
		})
	}
	// console.log('Object.keys() = ' + (new Date() - startTime))

	return d3Data2
}

function onValueDebugLog(snap) {
	var d3Data = convertFBSnapToD3Data(snap)
	redrawDebugLog.call(this, d3Data)
}

function addVizListFromThis() {
	console.log('addVizListFromThis : ' + this.streamUuid)
	refAllStreamInfoByUuid
	.child(this.streamUuid)
	.child('allSessionsRef')
	.once(
		'value',
		function (snap) {
			var ref
			console.log('addVizListFromThis allSessionsRef : ' + snap.val())
			ref = new Firebase(snap.val())
			allVizRefArraysByThingUuid[this.thingUuid].push(ref)
			ref
			.endAt()
			.limit(1)
			.on(
				'value',
				function (snap) {
					var obj = {}
					var refAllItems
					for(var key in snap.val()) { // convert JSON to array for use by d3
						obj = snap.val()[key]
					}
					refAllItems = new Firebase(obj['__REF__'])
					allVizRefArraysByThingUuid[this.thingUuid].push(refAllItems)
					console.log("Match? " + this.streamUuid + " and " + this.onValueFunction)
					refAllItems
					.endAt()
					.limit(this.info.limit)
					.on(
						'value',
						this.onValueFunction,
						function function_name (argument) {
							// callback canceled...
						},
						this
					)
				},
				function function_name (argument) {
					// callback canceled...
				},
				this
			)
		},
		function function_name (argument) {
			// callback canceled...
		},
		this
	)

}

function addVizFromThingUuid(thingUuid, info) {
	var refAllOutStreamUuidsByName // firebase reference
	var context = {}

	allVizd3SelArraysByThingUuid[thingUuid] = [] // cache dom elements globally for later removal
	allVizRefArraysByThingUuid[thingUuid] = [] // cache firebase callbacks gloablly for later removal

	context.thingUuid = thingUuid // callbacks will need to know their thingUuid
	// FIXME: is it better to get thingUuid from d3.select(this).attr('thingUuid') or from a global arrray instead?

	// add Name
	context.d3SelThing =
		d3SelThingVizs // cache <div> element for this thingUuid
			.append('div')
			.attr({
				thingUuid : thingUuid,
				class : 'panel panel-default col-12'
			})
	allVizd3SelArraysByThingUuid[thingUuid].push(context.d3SelThing)
	
	// create dom elements for Viz widgets
	context.d3SelThing
		.style('cursor', 'default')
		.call(appendThingName)

	// fill the thingUuidName widget
	context.d3SelThing.select('[name=thingName]')
		.text(info.name || thingUuid)

	refAllOutStreamUuidsByName = refAllThingInfoByUuid.child(thingUuid).child('allOutStreamUuidsByName')
	allVizRefArraysByThingUuid[thingUuid].push(refAllOutStreamUuidsByName)

	refAllOutStreamUuidsByName
	.once(
		'value',
		function (snap) {
			for (var name in snap.val()) {
				this.streamUuid = snap.val()[name]
				if (name == 'debugLog') {
					this.d3SelThing
						.call(appendDebugLog)
					addVizListFromThis.call({
						d3SelThing : this.d3SelThing,
						thingUuid : this.thingUuid,
						streamUuid : this.streamUuid,
						onValueFunction : onValueDebugLog,
						info : debugLogVizInfo
					})
				}
				if (name == 'debugLogB') {
					this.d3SelThing
						.call(appendDebugLogB)
					addVizListFromThis.call({
						d3SelThing : this.d3SelThing,
						thingUuid : this.thingUuid,
						streamUuid : this.streamUuid,
						onValueFunction : onValueDebugLog,
						info : debugLogVizInfoB
					})
				}
			}
		},
		function cancelCallback() {
			console.log('refAllOutStreamUuidsByName callback canceled')
		},
		context
	)

	// delete context.recentDebugLogs // FIXME: Why did I need this?  I forgot.
} // addVizFromThingUuid(...

// code starts here
logD3Sel.append('div').text(scriptVersion)

lineHeightGLobal = parseInt(logD3Sel.select('div').style('line-height'), 10) - 2 // HACK: '- 2' is a fudge
// FIXME: sometimes on page load the height is stll 0.  Maybe make an on resize event for this div to reset lineHeightGLobal?
console.log("lineHeightGLobal set to " + lineHeightGLobal)

logD3Sel.append('div').text('Loading Firebase...')
// DEPLOY: comment out this line before deploying
// Firebase.enableLogging(true)

// Start getting data from Firebase here
// These firebase refs exist as long as the page is loaded.
// No need to save them for later .off() calls
	// serverTimeOffsetRef - used for time sync.  could be better
	// refAllThingInfoByUuid
	
serverTimeOffsetRef.on('value', function (snap) {
// minimal effort here to sync local time and server time.
	var d3Sel = logD3Sel.selectAll('.fbLoadMessage')
		.data([true]) // FIXME: is there a better way?

	// data here
	serverTimeOffset = snap.val() // change global time offset
	
	// presentation part here.  TODO: seperate data and presentation?
	d3Sel.enter()	
		.append('div').attr({ class : 'fbLoadMessage' })
	d3Sel
		// .style({'background-color': firebaseColor.changed})
		.style({'background-color' : firebaseColor.added})
		.text('>Firebase Loaded. (serverTimeOffset = '
			+ serverTimeOffset + 'ms)')
		.transition().ease('linear').duration(333)
		.style({'background-color' : 'white'})
})

refAllThingInfoByUuid.on(
	'value',
	function(snap) {
		// clear existing
		d3SelViz.selectAll('*').remove()
		d3SelButtons = d3SelViz
			.append('div')
			.attr({
				class : 'panel panel-default col-12'
			})
			.append('div')
			.attr({
				class : 'panel-body btn-group',
				name : 'buttonContainer'
			})
		d3SelThingVizs = d3SelViz
			.append('div')
			.attr({
				name : 'thingUuidContainer'
			})

		// garbage collect timers and FB refs
			// FIXME: TODO garbage collection?
		// add new Viz for each thingUuid	
		for (var thingUuid in snap.val()) {
			var info = snap.val()[thingUuid]
			d3SelButtons
				.append('button')
				.attr({
					thingUuid : thingUuid,
					style : 'margin : 0px 2px;',
					class : 'btn-small col-4'
				})
				.text(info.name || thingUuid)
				.on('click', function() {
					var thingUuid = d3.select(this).attr('thingUuid')
					var info = snap.val()[thingUuid] // FIXME: how is snap included in context when referenced but not when not referenced and why is info not included in context
					console.log('clicked button thingUuid = ' + thingUuid)
					if (this.classList.toggle('btn-primary')) {
						// create new Viz dom elements and fb callbacks
						addVizFromThingUuid(thingUuid, info)
					} else {
						removeVizByThingUuid(thingUuid)
					}
				})
		}
	}
)//refAllThingInfoByUuid.on('value'...

}) ()

// end of code
