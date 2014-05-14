/* crispy hardware
/* ThingApp Device Electric Imp Squirrel code */

/////////////////////////////////////////////////
// global constants and variables

// generic
const versionString = "crispy BLE v00.01.2014-05-14a"
impeeID <- hardware.getimpeeid() // cache the impeeID FIXME: is this necessary for speed?
offsetMicros <- 0 // set later to microsseconds % 1000000 when time() rolls over //FIXME: need a better timesync solution here
const sleepforTimeout = 60 // seconds idle before decrementing idleCount
const idleCountMax = 240 //3 // number sleepforTimeout periods before server.sleepfor()
const sleepforDuration = 36000//300 // seconds to stay in deep sleep (wakeup is a reboot)
idleCount <- idleCountMax // Current count of idleCountMax timer

active <- false

// configuration variables
vBatt       <- hardware.pin2
serialPort  <- hardware.uart1289
spiPort     <- hardware.spi257
button <- hardware.pin1

// app specific globals

///////////////////////////////////////////////
//define functions

// start with generic functions
function timestamp() {
    local t, t2, m
    t = time() // CONSTRAINT: t= and m= should be atomic but aren't
    t2 = time()
    m = hardware.micros()
    if (t2 > t) { // check if time() seconds rolled over
        offsetMicros = m % 1000000// re-calibrate offsetMicros
        if (offsetMicros < 0) {
            offsetMicros += 1000000 // Squirrel mod is remainder, not modulos
        }
        m = (m - offsetMicros) % 1000000
        if (m < 0) {
            m += 1000000 // Squirrel mod is remainder, not modulos
        }
    } else {
        m = (m - offsetMicros) % 1000000
        if (m < 0) {
            m += 1000000 // Squirrel mod is remainder, not modulos
        }
        if (m < lastMicros && lastUTCSeconds == t2) {
            // we rolled over and didn't catch it
            t2 = t2 + 1
        }
    }
    lastMicros = m
    lastUTCSeconds = t2
    return format("%010u%06u", t2, m)
        // return microseconds since Unix epoch 
}

function checkActivity() {
// checkActivity re-schedules itself every sleepforTimeout
// FIXME: checkActivity should be more generic
    server.log("checkActivity() every " + sleepforTimeout + " secs.")
    // let the agent know we are still alive
    agent.send(
        "event",
        {
            "healthStatus" : {
                "keepAlive": idleCount,
                // "vBatt": getVBatt(),
                "t": timestamp(),
            },
            "t" : timestamp(),
        }
    )

    server.log("idle : " + idleCount)

    if (active) {
        active = false
        idleCount = idleCountMax // restart idle count down
    } else {
        if (idleCount == 0) {
            idleCount = idleCountMax
            led1.write(0)
            server.log("No activity for " + sleepforTimeout * idleCountMax + " to " + sleepforTimeout * (idleCountMax + 1) + " secs.\r\nGoing to deepsleep for " + (sleepforDuration / 60.0) + " minutes.")
            //
            // do app specific shutdown stuff here
            //
            // serialPort.write("impsleep")
            // serialPort.flush()
            imp.sleep(0.333)

            // keyPin.configure(DIGITAL_IN_WAKEUP, readKey)
            // led1.configure(DIGITAL_IN_WAKEUP, wakeup)
            imp.sleep(0.333)
            imp.onidle(function() { server.sleepfor(sleepforDuration) })  // go to deepsleep if no activity for sleepforTimeout
        } else {
            idleCount -= 1
            imp.setpowersave(true) // FIXME: currently uneccessary, we are always in 5mA powersave mode
        }
    }
    imp.wakeup(sleepforTimeout, checkActivity) // re-schedule self
} // checkActivity

function buttonPress() {
    local pressed = button.read()

    server.log("BUTTON " + pressed)
    if (pressed) {
        processCommand("BUTTON", "healthStatus")    
    }
}

function processCommand(commandString, port) {
    local message = {
        "t" : timestamp()
    }
    
    message[port] <- commandString    
    agent.send(
        "event",
         message
    )
}

function readSerialPort() {
    // Get first byte
    local timeKey = timestamp()
    local b = serialPort.read()

    // server.log("activity on serial port")
    active = true // signal activity to keep imp awake
    while (b != -1) {
        // process byte
        if (b != '\r') {   
            serialString.writen(b, 'b')
            // server.log("b = " + b + ", serialString.len() = " + serialString.len())
            if ( (serialString.tell() >= serialStringMaxLength)
            ||   (b == '\n') ) {
                local string = format("%s", "" + serialString)
                processCommand(string, "scanResponseBLE")
                serialString.resize(0)
            }
        }
        b = serialPort.read()
    }
}

////////////////////////////////////////////////////////
// first code starts here

imp.setpowersave(true) // start in low power mode.
/******* https://electricimp.com/docs/api/imp/setpowersave/
Power-save mode is disabled by default; this means the WiFi radio receiver is enabled constantly. This results in the lowest latency for data transfers, but a high power drain (~60-80mA at 3.3v).

Enabling power-save mode drops this down to < 5mA when the radio is idle (i.e., between transactions with the server). The down-side is added latency on received data transfers, which can be as high as 250ms.
*******/

// Send status to know we are alive
server.log("BOOTING  " + versionString + " " + hardware.getimpeeid() + "/" + imp.getmacaddress())
server.log("imp software version : " + imp.getsoftwareversion())
server.log("connected to WiFi : " + imp.getbssid())

// BUGBUG: below needed until newer firmware!?  See http://forums.electricimp.com/discussion/comment/4875#Comment_2714
// imp.enableblinkup(true)

lastUTCSeconds <- 0
newSeconds <- time()
do {
    lastUTCSeconds = newSeconds
    newSeconds = time()
    offsetMicros = hardware.micros()
} while (newSeconds == lastUTCSeconds) // wait for seonds to roll over
offsetMicros = hardware.micros() % 1000000
if (offsetMicros < 0) {
    offsetMicros += 1000000 // Squirrel mod is remainder, not modulos
}
lastUTCSeconds = newSeconds
lastMicros <- offsetMicros

// this re-calibrates if timestamp() is read at a seonds rollover
// FIXME: re-calibrate more often?
server.log("offsetMicros = " + offsetMicros)

serialStringMaxLength <- 80
serialString <- blob(0)
seriialLastTime <- timestamp()
serialPort.configure(230400, 8, PARITY_NONE, 1, NO_CTSRTS, readSerialPort)
button.configure(DIGITAL_IN_WAKEUP, buttonPress)

agent.send(
    "event",
     {
        "healthStatus" : "[BOOTING Electric Imp Device] " + versionString,
        "t" : timestamp(),
     }
)

checkActivity() // kickstart checkActivity, this re-schedules itself every sleepforTimeout seconds
// FIXME: checkActivity waits from sleepforTimeout to sleepforTimeout*2.  Make this more constant.

// No more code to execute so we'll sleep until an interrupts from serial or pin 1
// End of code.

// crispy hardware
// ThingApp Imp Device Squirrel code */
