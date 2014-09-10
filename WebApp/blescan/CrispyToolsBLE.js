(function Viz() {
'use strict'
///////////////////////////////////////////////////////////////////////////////
// live viewer of BLE scanner ouput.  BLE scanner logs to firebase ThingStreams
///////////////////////////////////////////////////////////////////////////////

// human readable version of this script
var scriptVersion = 'CrispyToolsBLE.js v2014-06-12a'

///////////////////////////////////////////////////////////////////////////////
// firebase references
///////////////////////////////////////////////////////////////////////////////
var rootRef = 'https://ibeacon-sequence-tsns.firebaseio.com/' // URL of the firebase
var refThingstreamServer = 'https://crispy-thingstream-name-server.firebaseio.com' // URL of the firebase
var tsVizD3Sel = d3.select('#TSViz') // d3 selection that holds all visualizations
var logD3Sel = d3.select('#TSLog') // d3 selection for log messages
var buttonsD3Sel // DOM element for Buttons
var vizsD3Sel // DOM element for all ThingStream Visualizations
var lineHeightGLobal = 18 // default guess, this is updated later in page load
var firebaseColor = { // local presentation colors FIXME: move to firebase Viz description?
		changed : '#f8c136',
		added : 'limegreen', // '#81b23c',
		deleted : '#ed1c23',
		moved : '#68b2d9',
		normal : '#c0c0c0'
	}
var serverTimeOffset = 0 // milliseconds
var serverTimeOffsetRef = new Firebase( [rootRef, '.info', 'serverTimeOffset'] .join('/') )
var allStreamInfoByUuidRef = new Firebase( [refThingstreamServer,	'allStreamInfoByUuid'] .join('/'))
var allThingInfoByUuidRef = new Firebase( [refThingstreamServer,	'allThingInfoByUuid'] .join('/'))
var allVizRefArraysByThingUuid = {} // save refs globally for cleanup when removed
var allVizd3SelArraysByThingUuid = {} // save dom elements globally for cleanup when removed
var scanResponseBLEVizInfo = { // TODO: get these *Info objects from cloud Viz name-server
		limit : 100, //100,
		title : 'BLE advertisements',
		VizName : 'BLEAdvPackets',
		VizTitle : 'scanResponseBLETitle'
	}
var historyBLEData
var healthStatusVizInfo = { // TODO: get these *Info objects from cloud Viz name-server
		limit : 100,
		title : 'Battery',
		VizName : 'healthBattLevel',
		VizTitle : 'healthStatusTitle'
	}

function throttleFunction(func, wait, options) {
    var context, args, result;
    var timeout = null;
    var previous = 0;
    options || (options = {});
    var later = function() {
      previous = options.leading === false ? 0 : new Date;
      timeout = null;
  		// console.log('throttleFunction Later', func.name, context, args)
      result = func.apply(context, args);
      context = args = null;
    };
    return function() {
      var now = new Date;
      if (!previous && options.leading === false) previous = now;
      var remaining = wait - (now - previous);
      context = this;
      args = arguments;
      if (remaining <= 0) {
        clearTimeout(timeout);
        timeout = null;
        previous = now;
  		// console.log('throttleFunction Immediate', func.name, 'remaining', remaining, context, args)
        result = func.apply(context, args);
        context = args = null;
      } else if (!timeout && options.trailing !== false) {
        timeout = setTimeout(later, remaining);
      }
      // return result;
      return timeout;
    };
};

function shiftClickDebug(d, i) {
// log debugging info when shiftClick on an element
	if (d3.event.shiftKey) {
		console.log(i, this)
		console.log(d)
		d3.event.stopPropagation()
	}
}

function authDeclined(err) {
	console.log('Firebase callback not authorized.')
	console.log(this)
	console.log(err)
}

function d3DataFromJSON(snapVal, keyName, filterFunction) {
	var profNow = new Date
	var mapD3Data = d3.map(snapVal) // FIXME: PERF: this is likely the slow part.  can I make it faster?
	// see https://github.com/mbostock/d3/wiki/Arrays#wiki-d3_map
	var result

	mapD3Data.entries().forEach(function (entry) {
		var datum = entry.value

		if (!filterFunction || filterFunction(datum)) { // if filterFunction exists, check it.
			datum[keyName] = entry.key // copy the keyName into the object for later access by d3 operations
		} else {
			mapD3Data.remove(entry.key) // don't include this object in d3Data
		}
	})

	result = mapD3Data.values() // d3 wants data in an array of objects

	profNow = (new Date) - profNow 
	if (profNow > 20) {
		console.log('profNow: d3DataFromJSON ' + profNow + 'msec')
	}

	return result
}

function serverNow() {
	return new Date().getTime() + serverTimeOffset
}

function getKey(keyName) {
	// use with selection.data(d3Data, getKey('foo')) or other
	return function (datum) {
		return datum[keyName]
	}
}

function compareKey(keyName, sortOrder, returnObject) {
	// sortOrder is >=0 for ascending, <0 for descending (reversed), ==0 for no change defaults to 1
	if (returnObject) {
		returnObject.swap = 0
		returnObject.equal = 0
	}
	return function (d1, d2) {
		var result = (sortOrder || 1) > 0 ? d1[keyName] - d2[keyName] : sortOrder < 0 ? d2[keyName] - d1[keyName] : 0
		if (returnObject) {
			result < 0 ? true
				: result > 0 ? returnObject.swap++
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
			class : 'col-sm-12'
		})
	sel
		.append('div')
		.attr({
			name : info.VizTitle,
			class : 'col-sm-12 text-center'
		})
	sel
		.append('div')		
		.attr({
			name : info.VizName,
			class : 'col-sm-12',
			style : 'resize:vertical;overflow:auto;height:248px'
		})
}

// function appendDebugLog(d3Selection) { // use with d3.call()
// 	appendList(d3Selection, debugLogVizInfo)
// 	d3Selection.select('[name=' + debugLogVizInfo.VizTitle + ']')
// 		.text(debugLogVizInfo.title)	
// }

function appendHealthStatus(d3Selection) { // use with d3.call()
	appendList(d3Selection, healthStatusVizInfo)
	d3Selection.select('[name=' + healthStatusVizInfo.VizTitle + ']')
		.text(healthStatusVizInfo.title)	
}

function appendScanResponseBLE(d3Selection) { // use with d3.call()
	appendList(d3Selection, scanResponseBLEVizInfo)
	d3Selection.select('[name=' + scanResponseBLEVizInfo.VizTitle + ']')
		.text(scanResponseBLEVizInfo.title)	
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
			style : "font:'Lucida Console';font-family:monospace;font-size:9pt;background:#000;color:#0cd"
		})
		.text(textFromD3Data)

	sessions
		.sort(compareKey('timeSessionStart'))

	sessions.exit()
		.remove()

	d.node().scrollTop = d.node().scrollHeight
} // redrawList()

function redrawBLEList(d3Data, textFromD3Data) {
	var d
	var sessions

	d = this.d3SelThing
		.selectAll('[name=' + this.info.VizName + ']')

	sessions = d
		.selectAll('div')
		.data(
			d3Data,
			function (d) {
				return d.MAC
			}
		)

	sessions.enter()
		.append('div')
		.attr({
			style : "font:'Lucida Console';font-family:monospace;font-size:9pt;background:#000;color:#0cd"
		})
		.text(textFromD3Data)

	sessions
		.sort(compareKey('MAC'))

	sessions.exit()
		.remove()

	d.node().scrollTop = d.node().scrollHeight
} // redrawBLEList()

function redrawDebugLog(d3Data) { // called on data change
	redrawList.call(this, d3Data, function (d) {
			return millisToLocalTimeStringFriendly(d.timeSessionStart) + '> ' + d.string
		})
} //redrawDebugLog()

function redrawHealthStatus(d3Data) { // called on data change
	redrawList.call(this, d3Data, function (d) {
			return millisToLocalTimeStringFriendly(d.timeSessionStart) + '> ' + d.string
		})
} //redrawHealthStatus()

function redrawScanResponseBLE(d3Data) { // called on data change
	redrawBLEList.call(this, d3Data, function (d) {
			return d.MAC + ' ' + d.rssi + ' ' + d.data
		})
} //redrawScanResponseBLE()

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
			obj : v[t],
			timeSessionStart : t
		})
	}
	// console.log('Object.keys() = ' + (new Date() - startTime))

	return d3Data2
}

function convertFBSnapToBLEData(snap) {
	var d3Data
	var d3Data2
	var BLEData
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

	BLEData = {}
	// startTime = new Date()
	keyArray = Object.keys(v)
	// go backwards in time so we see most recent
	for (var i = keyArray.length; i > 0; ) {
		var t
		var obj

		i -= 1
		t = keyArray[i]
		obj = v[t]

		if (obj.data && (obj.data.substr(10,2) == "4D")) {
			obj.timeSessionStart = t
			BLEData[obj.MAC] = obj
		}
	}
	// console.log('Object.keys() = ' + (new Date() - startTime))

	d3Data2 = []
	for (var key in BLEData) {
		d3Data2.push(BLEData[key])
	}

	return d3Data2
}

// function onValueDebugLog(snap) {
// 	var d3Data = convertFBSnapToD3Data(snap)
// 	redrawDebugLog.call(this, d3Data)
// }

function onValueHealthStatus(snap) {
	var d3Data = convertFBSnapToD3Data(snap)
	redrawDebugLog.call(this, d3Data)
}

function onValueScanResponseBLE(snap) {
	var BLEData = convertFBSnapToBLEData(snap)
	historyBLEData = BLEData
	redrawScanResponseBLE.call(this, historyBLEData)
}

function addVizListFromThis() {
	console.log('addVizListFromThis : ' + this.streamUuid)
	allStreamInfoByUuidRef
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
					refAllItems
					.endAt()
					.limit(this.info.limit)
					.on(
						'value',
						this.onValueFunction,
						authDeclined,
						this
					)
				},
				authDeclined,
				this
			)
		},
		authDeclined,
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
		vizsD3Sel // cache <div> element for this thingUuid
			.append('div')
			.attr({
				thingUuid : thingUuid,
				class : 'panel panel-default col-sm-12'
			})
	allVizd3SelArraysByThingUuid[thingUuid].push(context.d3SelThing)
	
	// create dom elements for Viz widgets
	context.d3SelThing
		.style('cursor', 'default')
		.call(appendThingName)

	// fill the thingUuidName widget
	context.d3SelThing.select('[name=thingName]')
		.text(info.name || thingUuid)

	refAllOutStreamUuidsByName = allThingInfoByUuidRef.child(thingUuid).child('allOutStreamUuidsByName')
	allVizRefArraysByThingUuid[thingUuid].push(refAllOutStreamUuidsByName)

	refAllOutStreamUuidsByName
	.once(
		'value',
		function (snap) {
			for (var name in snap.val()) {
				this.streamUuid = snap.val()[name]
				if (name == 'scanResponseBLE') {
					this.d3SelThing
						.call(appendScanResponseBLE)
					addVizListFromThis.call({
						d3SelThing : this.d3SelThing,
						thingUuid : this.thingUuid,
						streamUuid : this.streamUuid,
						onValueFunction : onValueScanResponseBLE,
						info : scanResponseBLEVizInfo
					})
				}
				// if (name == 'healthStatus') {
				// 	this.d3SelThing
				// 		.call(appendHealthStatus)
				// 	addVizListFromThis.call({
				// 		d3SelThing : this.d3SelThing,
				// 		thingUuid : this.thingUuid,
				// 		streamUuid : this.streamUuid,
				// 		onValueFunction : onValueHealthStatus,
				// 		info : healthStatusVizInfo
				// 	})
				// }
			}
		},
		authDeclined,
		context
	)

	// delete context.recentDebugLogs // FIXME: Why did I need this?  I forgot.
} // addVizFromThingUuid(...

function onClickButtonThingInfo() {
	var thingUuid = d3.select(this).attr('thingUuid')
	var info = d3.select(this).datum().info
	console.log('clicked button thingUuid = ' + thingUuid)
	if (this.classList.toggle('btn-primary')) {
		// create new Viz dom elements and fb callbacks
		addVizFromThingUuid(thingUuid, info)
	} else {
		removeVizByThingUuid(thingUuid)
	}
}

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
	// allThingInfoByUuidRef
	
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

allThingInfoByUuidRef.on(
	'value',
	function(snap) {
		// clear existing
		tsVizD3Sel.selectAll('*').remove()
		buttonsD3Sel = tsVizD3Sel
			.append('div')
			.attr({
				class : 'panel panel-default col-sm-12'
			})
			.append('div')
			.attr({
				class : 'panel-body btn-group',
				name : 'buttonContainer'
			})
		vizsD3Sel = tsVizD3Sel
			.append('div')
			.attr({
				name : 'thingUuidContainer'
			})

		// garbage collect timers and FB refs
			// FIXME: TODO garbage collection?
		// add new Viz for each thingUuid	
		for (var thingUuid in snap.val()) {
			var info = snap.val()[thingUuid]

			if (info.allOutStreamUuidsByName.scanResponseBLE) {
				var d3Sel = buttonsD3Sel
					.append('button')
					.attr({
						thingUuid : thingUuid,
						style : 'margin : 0px 2px;',
						class : 'btn-small col-sm-4'
					})
					.text(info.name || thingUuid)
					.datum({
						info : info
					})
					.on('click', onClickButtonThingInfo)

				// start with each button selected
				onClickButtonThingInfo.call(d3Sel.node())
			}
		}
	}
)//allThingInfoByUuidRef.on('value'...

}) ()

// end of code
