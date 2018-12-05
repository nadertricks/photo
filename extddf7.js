
function DataStream(data)
{
	this.data = data;
	this.position = 0;
	
	this.bytePosition = 0
	this.byteBuffer = 0
}
DataStream.prototype = {
	seek: function(ofs) {  this.position = Math.max(0, Math.min(this.data.length, ofs));  },
	
	readUint8: function() {  return this.data[this.position++];  },
	readUint16: function() {
		var pos = this.position;
		this.position+=2;
		return (this.data[pos]<<8) | this.data[pos+1];
	},
	bit : function() {
		if (this.bytePosition == 0) {
			this.byteBuffer = this.data[this.position++];

			if (this.byteBuffer == 0xff) this.position++;

			this.bytePosition = 8
		}
		return (this.byteBuffer >> --this.bytePosition) & 1
	},
	bits : function(length) {
		var bPos = this.bytePosition, bBuf = this.byteBuffer;
		var nextLength = Math.min(bPos, length)
		length -= nextLength
		bPos -= nextLength
		var currentBits = (bBuf >> bPos) & ((1 << nextLength) - 1)

		while (length > 0) {
			bBuf = this.data[this.position++];

			if (bBuf == 0xff) this.position++;

			nextLength = Math.min(8, length)
			length -= nextLength
			bPos = 8 - nextLength

			currentBits <<= nextLength
			currentBits |= (bBuf >> bPos) & ((1 << nextLength) - 1)
		}
		this.bytePosition = bPos;  this.byteBuffer = bBuf;
		return currentBits;
	}
}

var HuffmanNode = {};
HuffmanNode.make = function() {  return  [0,0,-1];  }
HuffmanNode.addAtLevel = function(vals, val, level)
{
	vals[HuffmanNode.mostLeft(vals, 0, level) + 2] = val;
}
	
HuffmanNode.mostLeft = function(vals, node, level) {
	if(vals[node+2] != -1) return 0;
	if(level        ==  0) return node;
	
	for(var i=0; i<2; i++) {
		if(vals[node+i]==0) {  vals[node+i]=vals.length;  vals.push(0);  vals.push(0);  vals.push(-1);  }
		var nn = HuffmanNode.mostLeft(vals, vals[node+i], level-1);
		if(nn != 0) return nn;
	}
	return 0;
}


HuffmanNode.decode = function(vals, bs) {
	var node = 0, nv = 0, bit = 0;
	var bPos = bs.bytePosition, bBuf = bs.byteBuffer;
	while(true) {
		if (bPos == 0) {
			bBuf = bs.data[bs.position++];
			if (bBuf == 0xff) bs.position++;
			bPos = 8;
		}
		bit = ((bBuf >> --bPos) & 1);
		node = vals[node + bit];  nv = vals[node+2];
		if(nv!=-1) {
			bs.bytePosition=bPos;  bs.byteBuffer=bBuf;
			return nv;
		}
	}
	return -1;
}




function Decoder (data) {
	this.stream = new DataStream(data);
	this.decodeHeader()
}

Decoder.prototype.decodeSOF3 = function (length) {
    this.precision = this.stream.readUint8()
    this.lines = this.stream.readUint16()
    this.samples = this.stream.readUint16()
    this.components = this.stream.readUint8()
    this.componentIndex = new Array(this.components)
    this.samplingFactorH = new Array(this.components)
    this.samplingFactorV = new Array(this.components)

    for (var i = 0; i < this.components; i++) {
      var component = this.stream.readUint8()
      var samplingFactor = this.stream.readUint8()

      this.stream.readUint8()

      this.componentIndex[component] = i
      this.samplingFactorH[i] = samplingFactor >> 4
      this.samplingFactorV[i] = samplingFactor & 0xf
    }

    this.stream.seek(this.stream.position + length - (6 + this.components * 3))
}

Decoder.prototype.buildTree = function () {
    var tableLength = 0
    var tableId = this.stream.readUint8()

    if (this.huffmanTrees==null)  this.huffmanTrees = {};

    var tree = this.huffmanTrees[tableId] = HuffmanNode.make()

    var codeLengthArray = new Array(16)

    for (var i = 0; i < 16; i++) {
      codeLengthArray[i] = this.stream.readUint8()
      tableLength += codeLengthArray[i]
    }

    for (var i = 0; i < 16; i++)
      for (var j = 0; j < codeLengthArray[i]; j++) 
		  HuffmanNode.addAtLevel(tree, this.stream.readUint8(), i+1);
        //tree.mostLeft(i + 1).value = this.stream.readUint8()
		
    return tableLength + 17
}

Decoder.prototype.decodeDHT = function(length) {
    while (length > 0) length -= this.buildTree();
}

Decoder.prototype.decodeSOS = function(length) {
    var components = this.stream.readUint8()

    if (!this.huffmanTreesSelected) {
      this.huffmanTreesSelected = [];
    }

    for (var i = 0; i < components; i++) {
      var component = this.stream.readUint8()
      var treeSelection = this.stream.readUint8()

      this.huffmanTreesSelected[this.componentIndex[component]] = this.huffmanTrees[treeSelection >> 4]
    }

    this.predictor = this.stream.readUint8()

    this.stream.seek(this.stream.position + length - (2 + components * 2))
}

Decoder.prototype.decodeHeader = function() {
    var done = false;
    var marker = this.stream.readUint16();

    if (marker !== Decoder.MARKER_SOI) return;

    do {
      var marker = this.stream.readUint16()
      var length = this.stream.readUint16() - 2

      switch (marker) {
        case Decoder.MARKER_SOF3:
          this.decodeSOF3(length)
          break
        case Decoder.MARKER_DHT:
          this.decodeDHT(length)
          break
        case Decoder.MARKER_SOS:
          this.decodeSOS(length)
          done = true
          break
        default:
          this.stream.seek(this.stream.position + length)
          break
      }
    } while (!done)
}

Decoder.prototype.decodeDiff = function(node) {
    var length = HuffmanNode.decode(node, this.stream);

    if (length == 16) return -32768

    var diff = this.stream.bits(length)

    if ((diff & (1 << (length - 1))) == 0)  diff -= (1 << length) - 1;

    return diff;
}

Decoder.prototype.decode = function (imageArray, stripeSize) {
		var cmps = this.components, smps = this.samples, lns = this.lines;
		var width = smps * cmps;
		var hts = this.huffmanTreesSelected.slice(0);
		hts.push(hts[0], hts[0], hts[0]);		

		for (var i = 0; i < cmps; i++) {
			imageArray[i] = this.decodeDiff(hts[i]) + (1 << (this.precision - 1))
		}

		for (var x = cmps; x < width; x++) {
			imageArray[x] = this.decodeDiff(hts[x&1]) + imageArray[x - cmps]
		}

		var offset = stripeSize;

		for (var y = 1; y < lns; y++) {
			for (var i = 0; i < cmps; i++) {
				imageArray[offset + i] = this.decodeDiff(hts[i]) + imageArray[offset + i - stripeSize]
			}
	  
			var pred = this.predictor;

			for (var x = cmps; x < width; x++) {
				var oxi = offset+x, predictor = 0

				if(pred==1) 
					predictor = imageArray[oxi - cmps];
				else if(pred==6)
					predictor = imageArray[oxi - stripeSize] + ((imageArray[oxi - cmps] - imageArray[oxi - cmps - stripeSize]) >> 1)
					

				imageArray[oxi] = predictor + this.decodeDiff(hts[x&1])
			}

			offset += stripeSize
		}
}


Decoder.MARKER_SOF3 = 0xffc3
Decoder.MARKER_DHT = 0xffc4
Decoder.MARKER_SOI = 0xffd8
Decoder.MARKER_SOS = 0xffda

//module.exports = Decoder

function LosslessJpegDecoder () {}
LosslessJpegDecoder.prototype.decode =  function(inputBuffer) {
    var decoder = new Decoder(inputBuffer);
	
    var BufferType = decoder.precision > 8 ? Uint16Array : Uint8Array;

    var outputBuffer = new BufferType(decoder.samples * decoder.lines * decoder.components);
	var sliceSize = decoder.samples * decoder.components;

    decoder.decode(outputBuffer, sliceSize);

    return outputBuffer;
}


	
	
	
	
	function PSI ()
	{
	}
	
	PSI.Parse = function(buff, genv)
	{
		buff = new Uint8Array(buff);
		
		var str = PSI.B.readASCII(buff, 0, buff.length);
		var lines = str.split(/[\n\r]+/);
		
		var crds = null;
		var epsv = null;
		
		for(var li=0; li<lines.length; li++)
		{
			var line = lines[li].trim();
			if(line.charAt(0)=="%") {
				while(line.charAt(0)=="%") line = line.slice(1);
				var pts = line.split(":");
				if(pts[0]=="BoundingBox")  crds = pts[1].trim().split(/[ ]+/).map(parseFloat); 
				if(line.indexOf("!PS-Adobe-3.0 EPSF-3.0")!=-1) epsv=line;
			}
		}
		
		if(epsv==null || crds==null) crds = [0,0,595, 842];
		
		var os = [];	// operand stack
		var ds = PSI._getDictStack([],{});
		var es = [{  typ:"file", val: {  buff:buff, off:0  }  }];	// execution stack
		var gs = [];
		var env = PSI._getEnv(crds);
		var time = Date.now();
		var repeat = true;
		while(repeat) repeat = PSI.step(os, ds, es, gs, env, genv);
		
		if(env.pgOpen) genv.ShowPage();
		genv.Done();
		//PSI.interpret(file, os, ds, es, [], gst, genv);
		console.log(Date.now()-time);
	}
	PSI._getDictStack = function(adefs, aprcs) {
		var defs = [
			"def","begin","end","currentfile","currentdict","known","version","currentpacking","setpacking","currentglobal","setglobal",
			"currentflat",
			"currentlinewidth","currentpoint","currentscreen","setscreen",
			"dict","string","readstring","readhexstring","readline","getinterval","putinterval","token",
			"array","aload","astore","length","matrix","mark","counttomark",
			"makefont","scalefont","stringwidth",
			
			"setfont", "setgray", "setrgbcolor","sethsbcolor", "setlinewidth", "setstrokeadjust","setflat","setlinecap","setlinejoin","setmiterlimit","setdash",
			"clip","eoclip","clippath","pathbbox",
			"newpath", "stroke", "fill", "eofill", "closepath","showpage","print",
			"moveto", "lineto", "curveto", "arc","arcn", "show","ashow","widthshow",
			"rmoveto","rlineto","rcurveto",
			"translate","rotate","scale","concat","concatmatrix","currentmatrix","setmatrix",
			
			"save","restore","gsave", "grestore",
			"usertime","readtime",
			"save", "restore","flush","readonly",
			
			"findresource","defineresource","image","colorimage",
			
			"xcheck",
			
			"if","ifelse","exec","stopped","dup","exch","copy","roll","index","pop","put","get","load","where","store","repeat","for","forall","loop","exit",
			"bind",
			"cvi","cvr","cvs","cvx",
			"add","sub","mul","div","idiv","bitshift","mod","exp","atan",
			"neg","abs","round","truncate","sqrt","ln","sin","cos",
			"srand","rand","==","transform","itransform","dtransform",
			"eq","ge","gt","le","lt","ne",
			"and","or","not",
			"filter",
			
			"begincmap","endcmap", "begincodespacerange","endcodespacerange", "beginbfrange","endbfrange","beginbfchar","endbfchar"
		].concat(adefs);
		
		var withCtx = ["image", "colorimage", "repeat", "for","forall","loop"];
		for(var i=0; i<withCtx.length; i++) defs.push(withCtx[i]+"---");
		
		var prcs = { 
			"findfont"    : "/Font findresource",
			"definefont"  : "/Font defineresource",
			"undefinefont": "/Font undefineresource"
		};
		prcs = PSI.makeProcs(prcs);
		for(var p in aprcs) prcs[p] = aprcs[p];
		
		var systemdict = {}, globaldict = {}, userdict = {}, statusdict = {};
		systemdict["systemdict"] = {typ:"dict", val:systemdict};
		systemdict["globaldict"] = {typ:"dict", val:globaldict};
		systemdict["userdict"  ] = {typ:"dict", val:userdict  };
		systemdict["statusdict"] = {typ:"dict", val:statusdict};
		systemdict["null"] = {typ:"null", val:null};
		
		for(var i=0; i<defs.length; i++) systemdict[defs[i]] = {  typ:"operator", val:defs[i]  };
		for(var p in prcs)               systemdict[p] = prcs[p];
		
		return [ systemdict,	globaldict, userdict ];  // dictionary stack
	}
	PSI._getEnv   = function(crds) {
		return {
			bb:crds,
			gst : PSI._getState(crds),
			pckn:false, amodeGlobal:false,
			cmnum:0, fnt:null,
			res:{},
			pgOpen:false
		}
	}
	PSI._getState = function(crds) {
		return {
			font : PSI._getFont(),
			dd: {flat:1},  // device-dependent
			space :"/DeviceGray",
			// fill
			ca: 1,
			colr  : [0,0,0],
			sspace:"/DeviceGray",
			// stroke
			CA: 1,
			COLR : [0,0,0],
			bmode: "/Normal",
			SA:false, OPM:0, AIS:false, OP:false, op:false, SMask:"/None",
			lwidth : 1,
			lcap: 0,
			ljoin: 0,
			mlimit: 10,
			SM : 0.1,
			doff: 0,
			dash: [],
			strokeAdj : false,
			ctm : [1,0,0,1,0,0],
			cpos: [0,0],
			pth : {cmds:[],crds:[]}, 
			cpth: {cmds:["M","L","L","L","Z"],crds:[crds[0],crds[1],crds[2],crds[1], crds[2],crds[3],crds[0],crds[3]]},  // clipping path
		};
	}
	PSI._getFont = function() {
		return {
			Tc: 0, // character spacing
			Tw: 0, // word spacing
			Th:100, // horizontal scale
			Tl: 0, // leading
			Tf:"Helvetica-Bold", 
			Tfs:1, // font size
			Tmode:0, // rendering mode
			Trise:0, // rise
			Tk: 0,  // knockout
			
			Tm :[1,0,0,1,0,0],
			Tlm:[1,0,0,1,0,0],
			Trm:[1,0,0,1,0,0]
		};
	}
	
	PSI.makeProcs = function(prcs) {
		var out = {};
		for(var p in prcs) {
			var pts = prcs[p].replace(/  +/g, " ").split(" ");
			out[p] = {typ:"procedure", val:[]};
			for(var i=0; i<pts.length; i++) out[p].val.push({typ:"name",val:pts[i]});
		}
		return out;
	}
	
	PSI.addProc = function(obj, es) {  
		if(obj.val.length==0) return;
		if(obj.off!=null && obj.off!=obj.val.length)   es.push({typ:"procedure", val:obj.val, off:0}); 
		else {  obj.off=0;  es.push( obj );  }
	}
	
	PSI._f32 = new Float32Array(1);
	PSI.step = function(os, ds, es, gs, env, genv, Oprs) 
	{
		var otime = Date.now(), f32 = PSI._f32;
		var getToken = PSI.getToken;
		
		var gst = env.gst;
		
		var tok = getToken(es, ds);  if(tok==null) return false;
		var typ = tok.typ, val = tok.val;
		
		if(!env.pgOpen && val!="end") {  genv.StartPage(env.bb[0], env.bb[1], env.bb[2], env.bb[3]);  env.pgOpen = true;   }
		
		//console.log(tok, os.slice(0));
		/*ocnt++;
		//if(ocnt>2*lcnt) {  lcnt=ocnt;  console.log(ocnt, os.length, file.stk.length);  };
		if(ocnt>8000000) {  
			for(var key in opoc) if(opoc[key][1]<1000) delete opoc[key];
			console.log(Date.now()-otime, opoc);  throw "e";  
		} */
		
		if(typ=="integer" || typ=="real" || typ=="boolean" || typ=="string" || typ=="array" || typ=="procedure" || typ=="null") {  os.push(tok);  return true;  }
	
		if(typ!="name" && typ!="operator") throw "e";
		
		//if(opoc[val]==null) opoc[val]=[0,0];  opoc[val][0]++;  opoc[val][1]=ocnt;
			
		if(val.charAt(0)=="/") {
			if(val.charAt(1)=="/") throw "e";
			else os.push(tok);
		}
		else if(val=="{") {
			var ars = [], car = {typ:"procedure", val:[] };
			
			var ltok=getToken(es,ds); 
			while(true) {  
				if     (ltok.val=="{") {  var ncr = {typ:"procedure", val:[]};  car.val.push(ncr);  ars.push(car);  car=ncr;  }
				else if(ltok.val=="}") {  if(ars.length==0) break;  car = ars.pop();  }		
				else car.val.push(ltok);
				ltok=getToken(es,ds);  
			}
			os.push( car );
		}
		else if(val=="[" || val=="<<") os.push( {typ:"mark"} );
		else if(val=="]" || val==">>") {
			var arr = [];  while(os.length!=0) {  var o=os.pop();  if(o.typ=="mark") break;  arr.push(o);  }
			arr.reverse(); 
			if(val=="]") os.push( {typ:"array", val:arr } ); 
			else { 
				var ndct = {};  for(var i=0; i<arr.length; i+=2) ndct[arr[i].val.slice(1)] = arr[i+1];
				os.push( {typ:"dict", val:ndct } ); 
			}
		}
		else {
			var obj = PSI.getFromStacks(val, ds);
			
			//if(val=="rl^") {  console.log(val, os.slice(0));    }
			if(obj==null) {  console.log("unknown operator", val, os, ds);  throw "e";  }
			else if(obj.typ=="procedure") PSI.addProc(obj, es); //{  obj.off=0;  es.push(obj);  }
			/*
			else if(op.typ=="string") {
				var prc=[], sdta = {buff:op.val, off:0, stk:[]}, tk = getToken(sdta);  while(tk!=null) {  prc.push(tk);  tk=getToken(sdta);  }
				PSI.addProcedure(prc, file);
			}*/
			else if(["array","string","dict","null","integer","real","boolean","state","font","name"].indexOf(obj.typ)!=-1) os.push(obj);
			else if(obj.typ=="operator")
			{
				var op = obj.val;
				//if(omap[op]) op = omap[op];
				
				if(op=="def") {  var nv = os.pop(), nn = os.pop();  nn=nn.val.slice(1);  ds[ds.length-1][nn] = nv;  }
				else if(op=="dict"   ) {  os.pop().val;  os.push({typ:"dict"  , val:{} });  }
				else if(op=="string" ) {  var l=os.pop().val;  os.push({typ:"string", val:new Array(l) });  }
				else if(op=="readstring" || op=="readhexstring") {
					var str = os.pop(), l=str.val.length, fl = os.pop().val;  //console.log(op, str);  throw "e";
					if(op=="readstring") {  for(var i=0; i<l; i++) str.val[i]=fl.buff[fl.off+i];   fl.off+=l;  }
					else {
						var nv = PSI.readHex(fl, l);
						for(var i=0; i<nv.length; i++) str.val[i]=nv[i];
					}
					os.push(str, {typ:"boolean",val:true});
				}
				else if(op=="readline") {
					var str = os.pop(), fl = os.pop().val, i=0;
					if(PSI.isEOL(fl.buff[fl.off])) fl.off++;
					while(true)  {
						var cc = fl.buff[fl.off];  fl.off++;
						if(PSI.isEOL(cc)) break;
						str.val[i]=cc;   i++;
					}
					if(i<str.val.length && str.val[i]!=null) str.val[i]=null;
					os.push(str, {typ:"boolean",val:true});
				}
				else if(op=="getinterval") {
					var cnt = os.pop().val, idx = os.pop().val, src = os.pop(), out=[];
					if(src.typ=="string") for(var i=0; i<cnt; i++) out.push(src.val[idx+i]);
					else throw "e";
					//console.log(idx,cnt,out.slice(0));
					os.push({typ:src.typ, val:out});
				}
				else if(op=="putinterval") {
					var src=os.pop(), idx=os.pop().val, tgt=os.pop();
					if(idx+src.val.length>=tgt.val.length) throw "e";
					if(src.typ=="string") for(var i=0; i<src.val.length; i++) tgt.val[idx+i] = src.val[i];
					else throw "e";
					//console.log(src.val, tgt.val, idx);  throw "e";
				}
				else if(op=="token") {
					var src = os.pop();  if(src.typ!="string") throw "e";
					var arr = [];
					for(var i=0; i<src.val.length; i++) {  var bv=src.val[i];  if(bv==null) break;  arr.push(bv);  }
					var nfl = {  buff:new Uint8Array(arr), off:0   }, tok = getToken([{typ:"file",val:nfl}], ds);
					var ns = [];  for(var i=nfl.off; i<arr.length; i++) ns.push(arr[i]);
					os.push({typ:"string",val:ns}, tok, {typ:"boolean",val:true});
				}
				else if(op=="array"  ) {  var l=os.pop().val;  os.push({typ:"array" , val:new Array(l) });  }
				else if(op=="aload"){
					var o = os.pop(), arr = o.val;
					for(var i=0; i<arr.length; i++) os.push(arr[i]);
					os.push(o);
				}
				else if(op=="astore") {
					var o=os.pop(), arr = o.val;  //console.log(arr.length);  throw "e";
					for(var i=0; i<arr.length; i++) arr[arr.length-1-i]=os.pop();
					os.push(o);
				}
				else if(op=="length" ) {
					var o = os.pop(), typ=o.typ, l=0;
					if(typ=="array") l = o.val.length;
					else if(typ=="procedure") l = o.val.length;
					else {  console.log(o);  throw "e";  }
					os.push({typ:"integer",val:l});
				}
				else if(op=="matrix" ) {  os.push({typ:"array", val:PSI.makeArr([1,0,0,1,0,0],"real") });  }
				else if(op=="mark"   ) {  os.push({typ:"mark"});  }
				else if(op=="counttomark") {
					var i=os.length-1;  while(i!=-1 && os[i].typ!="mark") i--;
					os.push({typ:"integer",val:os.length-1-i});
				}
				else if(op=="begin") {  var o = os.pop(), dct=o.val;   if(dct==null || o.typ!="dict") {  console.log(o, ds);  throw "e";  }  ds.push(dct);  }
				else if(op=="end"  ) {  ds.pop();  }
				else if(op=="currentfile") {  var file;  for(var i=es.length-1; i>=0; i--) if(es[i].typ=="file")file=es[i];  os.push(file);  }
				else if(op=="currentdict") {  var dct=ds[ds.length-1];  os.push({typ:"dict", val:dct});  }
				else if(op=="known") {  var key=os.pop().val.slice(1), dct=os.pop().val;  os.push({typ:"boolean",val:dct[key]!=null});  }
				else if(op=="version") {  os.push({typ:"string", val:[51]});  } // "3"
				else if(op=="currentpacking") {  os.push({typ:"boolean",val:env.pckn});  }
				else if(op=="setpacking"    ) {  env.pckn = os.pop().val;  }
				else if(op=="currentglobal" ) {  os.push({typ:"boolean",val:env.amodeGlobal});  }
				else if(op=="setglobal"     ) {  env.amodeGlobal = os.pop().val;  }
				else if(op=="currentflat"   ) {  os.push({typ:"real",val:1});  }
				else if(op=="currentlinewidth") {  os.push({typ:"real",val:gst.lwidth});  }
				else if(op=="currentpoint"   ) {  var im=gst.ctm.slice(0);  PSI.M.invert(im);  var p=PSI.M.multPoint(im,gst.cpos);  
								os.push({typ:"real",val:p[0]}, {typ:"real",val:p[1]});  }
				else if(op=="currentscreen"  ) {  os.push({typ:"int",val:60}, {typ:"real",val:0},{typ:"real",val:0});  }
				else if(op=="setscreen"      ) {  os.pop();  os.pop();  os.pop();  }
				else if(op=="findresource")
				{
					var cat = os.pop().val.slice(1), key = os.pop().val.slice(1);
					if     (cat=="Font") {  rs = {typ:"font",val:PSI._getFont()};  rs.val.Tf=key;  }
					else if(cat=="ProcSet") rs = {typ:"dict",val:{}};
					else throw("Unknown resource category: "+cat);
					os.push(rs);
				}
				else if(op=="defineresource") {
					var cat = os.pop().val.slice(1), ins = os.pop().val, key = os.pop().val.slice(1);
					if(env.res[cat]==null) env.res[cat]={};
					env.res[cat][key]=ins;
				}
				else if(op=="image" || op=="colorimage") {
					var ncomp = 1, multi = false;
					if(op=="colorimage") {  ncomp = os.pop().val;  multi = os.pop().val;  }
					var src0, src1, src2;  
					if(multi) {  src2=os.pop();  src1=os.pop();  src0=os.pop();  }  else src0 = os.pop();
					var mat = PSI.readArr(os.pop().val), bpc = os.pop().val, h = os.pop().val, w = os.pop().val;
					
					if(ncomp!=3) throw "unsupported number of channels "+ncomp;
					if(bpc!=8) throw "unsupported bits per channel: "+bpc;
					
					var img = new Uint8Array(w*h*4);  for(var i=0; i<img.length; i++) img[i]=255;
					
					es.push({typ:"name",val:op+"---",ctx:[w,h,bpc,mat, ncomp,multi,img,0, src0,src1,src2]});
					PSI.addProc(src0, es);  
					if(multi) {  PSI.addProc(src1, es);  PSI.addProc(src2, es);  }
					//console.log(w,h,bpc,mat, src0,src1,src2, multi, ncomp);  throw "e";
				}
				else if(op=="image---" || op=="colorimage---") {
					var prm = tok.ctx, w=prm[0], h=prm[1], bpc=prm[2], mat=prm[3], ncomp=prm[4], multi=prm[5], img=prm[6], pind=prm[7];
					var src0 = prm[8], src1 = prm[9], src2=prm[10], dlen = 0;
					if(multi)
						for(i=0; i<3; i++){  var row = os.pop().val;  dlen = row.length;
							for(var j=0; j<dlen; j++) img[(pind+j)*4 + 2-i] = row[j];
						}
					else  {
						var row = os.pop().val;  dlen = Math.floor(row.length/3);
						if(row[0]==null) {  console.log(ds);  throw "e";  }
						for(var j=0; j<dlen; j++) {  var tj=j*3, qj=(pind+j)*4;  img[qj+0]=row[tj+0];  img[qj+1]=row[tj+1];  img[qj+2]=row[tj+2];  }
					}
					pind += dlen;
					if(pind==w*h) genv.PutImage(gst, img, w, h);
					else {  prm[7]=pind;  es.push(tok); 
						PSI.addProc(src0, es);  
						if(multi) {  PSI.addProc(src1, es);  PSI.addProc(src2, es);  }
					}
				}
				else if(op=="makefont") {
					var mt = PSI.readArr(os.pop().val), fnt = JSON.parse(JSON.stringify(os.pop()));
					PSI.M.concat(fnt.val.Tm, mt);  os.push(fnt);
				}
				else if(op=="scalefont") {
					var sc = os.pop().val, fnt = os.pop();  //console.log(ds);
					fnt.val.Tfs *= sc;  os.push(fnt);
				}
				else if(op=="stringwidth") {
					var str=os.pop().val;
					var sc = PSI.M.getScale(gst.font.Tm) / PSI.M.getScale(gst.ctm);
					//console.log(PSI.getString(str), gst.font, 0.6*sc*str.length);
					os.push({typ:"real",val:0.6*sc*str.length}, {typ:"real",val:sc});
				}
				else if(op=="setfont"     ) gst.font = os.pop().val;
				else if(op=="setlinewidth") gst.lwidth = os.pop().val;
				else if(op=="setstrokeadjust") gst.strokeAdj = os.pop().val;
				else if(op=="setlinecap") gst.lcap = os.pop().val;
				else if(op=="setlinejoin") gst.ljoin = os.pop().val;
				else if(op=="setmiterlimit") gst.mlimit = os.pop().val;
				else if(op=="setflat") gst.dd.flat=os.pop();
				else if(op=="setdash"     ) {  gst.doff=os.pop().val;  gst.dash = PSI.readArr(os.pop().val);  }
				else if(op=="show"||op=="ashow"||op=="widthshow") {  
					var sar = os.pop().val, str=PSI.readStr(sar); 
					if(op=="widthshow") {  os.pop();  os.pop();  os.pop();  }
					if(op=="ashow"    ) {  os.pop();  os.pop();  }
					var om = gst.ctm;  gst.ctm = om.slice(0);  gst.ctm[4]=gst.cpos[0];  gst.ctm[5]=gst.cpos[1];//PSI.M.translate(gst.ctm,gst.cpos[0],gst.cpos[1]);
					genv.PutText(gst, str, str.length*0.55);  gst.cpos[0] += str.length*PSI.M.getScale(om)*gst.font.Tfs*0.55;  //console.log(str, gst.font.Tfs);
					gst.ctm = om;
				}
				else if(op=="setgray"    ) {  var g=PSI.nrm(os.pop().val);  gst.colr = gst.COLR = [g,g,g];  }
				else if(op=="setrgbcolor") {  var b=os.pop().val,g=os.pop().val,r=os.pop().val;  gst.colr = gst.COLR = [PSI.nrm(r),PSI.nrm(g),PSI.nrm(b)];  }
				else if(op=="sethsbcolor") {
					var v=os.pop().val,s=os.pop().val,h=os.pop().val;
					var r, g, b, i, f, p, q, t;
					i = Math.floor(h * 6);
					f = h * 6 - i;
					p = v * (1 - s);
					q = v * (1 - f * s);
					t = v * (1 - (1 - f) * s);
					switch (i % 6) {
						case 0: r = v, g = t, b = p; break;
						case 1: r = q, g = v, b = p; break;
						case 2: r = p, g = v, b = t; break;
						case 3: r = p, g = q, b = v; break;
						case 4: r = t, g = p, b = v; break;
						case 5: r = v, g = p, b = q; break;
					}
					gst.colr = gst.COLR = [PSI.nrm(r),PSI.nrm(g),PSI.nrm(b)];
				}
				else if(op=="clip" || op=="eoclip") {  gst.cpth = JSON.parse(JSON.stringify(gst.pth ));  }
				else if(op=="clippath" ) {  gst.pth  = JSON.parse(JSON.stringify(gst.cpth));  }
				else if(op=="pathbbox" ) {
					var ps = gst.pth.crds;
					var bb = PSI.G.getBB(ps);
					ps = [bb[0],bb[1], bb[2],bb[1],   bb[0],bb[3], bb[2],bb[3]];
					var im = gst.ctm.slice(0);  PSI.M.invert(im);  PSI.M.multArray(im,ps);
					bb = PSI.G.getBB(ps);
					f32[0]=bb[0];  bb[0]=f32[0];  f32[0]=bb[1];  bb[1]=f32[0];  f32[0]=bb[2];  bb[2]=f32[0];  f32[0]=bb[3];  bb[3]=f32[0];
					bb = PSI.makeArr(bb,"real");
					os.push(bb[0],bb[1],bb[2],bb[3]);
				}
				else if(op=="newpath"  ) PSI.G.newPath(gst);
				else if(op=="stroke"              ) {  genv.Stroke(gst);  PSI.G.newPath(gst);  }
				else if(op=="fill" || op=="eofill") {  genv.Fill(gst, op=="eofill");    PSI.G.newPath(gst);  }
				else if(op=="closepath") PSI.G.closePath(gst);
				else if(op=="showpage" ) {  genv.ShowPage ();  var ofnt=gst.font;  gst = env.gst = PSI._getState(env.bb);  gst.font=ofnt;  env.pgOpen = false;  }
				else if(op=="print"    ) {  var sar = os.pop().val, str=PSI.readStr(sar);  genv.Print(str);  }
				else if(op=="moveto"  || op=="lineto" ) {
					var y = os.pop().val, x = os.pop().val;
					if(op=="moveto" ) PSI.G.moveTo(gst,x,y);  else PSI.G.lineTo(gst,x,y);
				}
				else if(op=="rmoveto" || op=="rlineto") {
					var y = os.pop().val, x = os.pop().val;
					var im=gst.ctm.slice(0);  PSI.M.invert(im);  var p = PSI.M.multPoint(im, gst.cpos);
					y+=p[1];  x+=p[0];
					if(op=="rmoveto") PSI.G.moveTo(gst,x,y);  else PSI.G.lineTo(gst,x,y);
				}
				else if(op=="curveto") {
					var y3=os.pop().val, x3=os.pop().val, y2=os.pop().val, x2=os.pop().val, y1=os.pop().val, x1=os.pop().val;
					PSI.G.curveTo(gst,x1,y1,x2,y2,x3,y3);
				}
				else if(op=="arc" || op=="arcn") {
					var a2 = os.pop().val, a1 = os.pop().val, r = os.pop().val, y = os.pop().val, x = os.pop().val;
					//if(op=="arcn") a2=-a2;
					PSI.G.arc(gst,x,y,r,a1*Math.PI/180,a2*Math.PI/180, op=="arcn");
				}
				
				else if(["translate","scale","rotate","concat"].indexOf(op)!=-1) {
					var v = os.pop(), m, x, y;
					if(v.typ=="array") {  m = PSI.readArr(v.val);  y = os.pop().val;  }
					else  {  m = [1,0,0,1,0,0];  y = v.val;  }
					
					if(op=="translate" || op=="scale") x = os.pop().val;
					
					if(op=="translate") PSI.M.translate(m,x,y);
					if(op=="scale"    ) PSI.M.scale    (m,x,y);
					if(op=="rotate"   ) PSI.M.rotate   (m,-y*Math.PI/180);
					if(op=="concat"   ) PSI.M.concat   (m,y);
					
					if(v.typ=="array") os.push({typ:"array",val:PSI.makeArr(m,"real")});
					else {  PSI.M.concat(m,gst.ctm);  gst.ctm = m;  }
				}
				else if(op=="concatmatrix") { var rA = PSI.readArr;
					var m3 = rA(os.pop().val), m2 = rA(os.pop().val), m1 = rA(os.pop().val);
					var m = m1.slice(0);  PSI.M.concat(m, m2);  m = PSI.makeArr(m, "real");
					os.push({typ:"array",val:m});
				}
				else if(op=="currentmatrix") {
					var m = os.pop(), cm = PSI.makeArr(gst.ctm,"real");  // console.log(m, cm);  throw "e";
					for(var i=0; i<6; i++) m.val[i]=cm[i];   os.push(m);
				}
				else if(op=="setmatrix") {
					gst.ctm = PSI.readArr(os.pop().val);
				}
				else if(op=="cvi") {
					var o = os.pop(), v=o.val, out = 0;
					if     (o.typ=="real"   ) out = Math.round(v);
					else if(o.typ=="integer") out = v;
					else throw "unknown type "+o.typ;
					os.push({typ:"integer",val:out});
				}
				else if(op=="cvr") {
					var o = os.pop(), v=o.val, out = 0;
					if     (o.typ=="real"   ) out = v;
					else if(o.typ=="integer") out = v;
					else if(o.typ=="string" ) out = parseFloat(PSI.readStr(v));
					else throw "unknown type "+o.typ;
					os.push({typ:"real",val:out});
				}
				else if(op=="cvs") {
					var str = os.pop(), any = os.pop(), nv = "";  str.val=[];  os.push(str);
					if(any.typ=="real" || any.typ=="integer") {
						if(Math.abs(Math.round(any.val)-any.val)<1e-6) nv=Math.round(any.val)+".0";
						else nv = (Math.round(any.val*1000000)/1000000).toString();
					}
					else throw "unknown var type: "+any.typ;
					for(var i=0; i<nv.length; i++) str.val[i]=nv.charCodeAt(i);
				}
				else if(op=="cvx") {
					var o = os.pop();
					//if(o.typ=="array") o.typ="procedure";
					//else if(o.typ=="name" && o.val.charAt(0)=="/") o = {typ:"name",val:o.val.slice(1)};
					//else {  console.log(o);  throw "e";  }
					os.push(o);
				}
				else if(["add","sub","mul","div","idiv","bitshift","mod","exp","atan"].indexOf(op)!=-1) {
					var o1 = os.pop(), o0 = os.pop(), v0=o0.val, v1=o1.val, out = 0, otp = "";
					if(op=="add" || op=="sub" || op=="mul") otp = (o0.typ=="real" || o1.typ=="real") ? "real" : "integer";
					else if(op=="div" || op=="atan" || op=="exp") otp = "real";
					else if(op=="mod" || op=="idiv" || op=="bitshift") otp = "integer";
					
					if(o0.typ=="real") {  f32[0]=v0;  v0=f32[0];  }
					if(o1.typ=="real") {  f32[0]=v1;  v1=f32[0];  }
					
					if(op=="add") out = v0+v1;
					if(op=="sub") out = v0-v1;
					if(op=="mul") out = v0*v1;
					if(op=="div") out = v0/v1;
					if(op=="idiv")out = ~~(v0/v1);
					if(op=="bitshift") out = v1>0 ? (v0<<v1) : (v0>>>(-v1));
					if(op=="mod") out = v0%v1;
					if(op=="exp") out = Math.pow(v0, v1);
					if(op=="atan")out = Math.atan2(v0, v1)*180/Math.PI;
					
					if(otp=="real") {  f32[0]=out;  out=f32[0];  }
					os.push({ typ:otp, val:out });
				}
				else if(["neg","abs","round","truncate","sqrt","ln","sin","cos"].indexOf(op)!=-1) {
					var o0 = os.pop(), v0=o0.val, out = 0, otp = "";
					if(op=="neg" || op=="abs" || op=="truncate") otp=o0.typ;
					else if(op=="round") otp="integer";
					else if(op=="sqrt" || op=="sin" || op=="cos" || op=="ln") otp="real";
					
					if(o0.typ=="real") {  f32[0]=v0;  v0=f32[0];  }
					
					if(op=="neg" ) out = -v0;
					if(op=="abs" ) out = Math.abs(v0);
					if(op=="round")out = Math.round(v0);
					if(op=="truncate") out = Math.trunc(v0);
					if(op=="sqrt") out = Math.sqrt(v0);
					if(op=="ln"  ) out = Math.log(v0);
					if(op=="sin" ) out = Math.sin(v0*Math.PI/180);
					if(op=="cos" ) out = Math.cos(v0*Math.PI/180);
					
					if(op=="ln" && v0<=0)  throw "e";
					
					if(otp=="real") {  f32[0]=out;  out=f32[0];  }
					
					os.push({typ:otp, val:out});
				}
				else if(["eq","ge","gt","le","lt","ne"].indexOf(op)!=-1) {
					var o1=os.pop(), o0=os.pop(), v0=o0.val, v1=o1.val, out=false;
					if(op=="eq") out=v0==v1;
					if(op=="ge") out=v0>=v1;
					if(op=="gt") out=v0> v1;
					if(op=="le") out=v0<=v1;
					if(op=="lt") out=v0< v1;
					if(op=="ne") out=v0!=v1;
					os.push({typ:"boolean",val:out});
				}
				else if(["and","or"].indexOf(op)!=-1) {
					var b2 = os.pop(), b1 = os.pop(), v1=b1.val, v2 = b2.val, ints=(b1.typ=="integer"), out;
					if(op=="and") out = ints ? (v1&v2) : (v1&&v2);
					if(op=="or" ) out = ints ? (v1|v2) : (v1||v2);
					os.push({typ:ints?"integer":"boolean", val:out});
				}
				else if(op=="not") {
					var b=os.pop(), v=b.val, ints=b.typ=="integer";
					var out = ints ? (~v) : (!v);
					os.push({typ:ints?"integer":"boolean", val:out});
				}
				else if(op=="if") {
					var proc = os.pop(), cnd = os.pop().val;
					if(cnd) PSI.addProc(proc, es);//PSI.callProcedure(proc, file, os, ds, es, gs, gst, genv);
				}
				else if(op=="ifelse") {
					var proc2 = os.pop(), proc1 = os.pop(), cnd = os.pop().val;
					PSI.addProc(cnd?proc1:proc2, es);
				}
				else if(op=="exec" || op=="stopped") {  var obj = os.pop();  
					if(op=="stopped") os.push({typ:"boolean", val:false});
				
					if(obj.typ=="procedure") PSI.addProc(obj, es);  
					else if(obj.typ=="name") PSI.addProc({typ:"procedure",val:[obj]},es);
					else throw "unknown executable type: "+obj.typ;
				}
				else if(op=="dup" ) {  var v=os.pop();  os.push(v,v);  }
				else if(op=="exch") {  os.push(os.pop(), os.pop());  }
				else if(op=="copy") {
					var n = os.pop();  //console.log(n);
					if(n.typ=="integer") {  var els=[];  for(var i=0; i<n.val; i++) els[n.val-1-i] = os.pop();  
						for(var i=0; i<n.val; i++) os.push(els[i]);  
						for(var i=0; i<n.val; i++) os.push(els[i]);    }
					else if(n.typ=="array") {
						var m = os.pop().val;
						for(var i=0; i<m.length; i++) {  n.val[i]=m[i];  if(m[i].val==null) {  console.log(ds);  throw "e"; }  }
						os.push(n);
					}
					else throw "e";
				}
				else if(op=="roll") {  var j=os.pop().val, n = os.pop().val;
					var els = [];  for(var i=0; i<n; i++) els.push(os.pop());  els.reverse();
					j = (n+j)%n;
					for(var i=0; i<j; i++) els.unshift(els.pop());
					for(var i=0; i<n; i++) os.push(els[i]);
				}
				else if(op=="index") {  var n=os.pop().val;  os.push(os[os.length-1-n]);  }
				else if(op=="transform" || op=="itransform" || op=="dtransform") {
					var m = os.pop(), y=0, x=0;  //console.log(m);
					if(m.typ=="array") { m = PSI.readArr(m.val);  y = os.pop().val;  }
					else               { y = m.val;  m = gst.ctm.slice(0);  }
					if(op=="itransform") {  PSI.M.invert(m);  }
					x = os.pop().val;
					var np = PSI.M.multPoint(m, [x,y]);
					if(op=="dtransform") {  np[0]-=m[4];  np[1]-=m[5];  }
					os.push({typ:"real",val:np[0]},{typ:"real",val:np[1]});
				}
				else if(op=="pop" || op=="srand" || op=="==" ) {  os.pop();   }
				else if(op=="rand") {  os.push({typ:"integer",val:Math.floor(Math.random()*0x7fffffff)});  }
				else if(op=="put" ) {  
					var val=os.pop(), o=os.pop(), obj=os.pop(), otp=obj.typ;  //console.log(obj,o,val);  throw "e";
					if(otp=="array") obj.val[o.val] = val;
					else if(otp=="dict")  obj.val[o.val.slice(1)]=val;
					else throw "e";
					//.val.slice(1), obj=os.pop();  obj.val[key]=obj.typ=="string" ? val.val : val;  
				}
				else if(op=="get" ) {  
					var o=os.pop(), obj=os.pop(), otp=obj.typ; //  console.log(o, obj);
					if     (otp=="string") os.push({typ:"integer",val:obj.val[o.val]}); 
					else if(otp=="array" ) os.push(obj.val[o.val]);
					else throw "getting from unknown type "+  obj.typ;  //os.push(obj.val[key]);  
				}
				else if(op=="load") {  var key=os.pop().val.slice(1), val = PSI.getFromStacks(key, ds);  
					if(val==null) {  console.log(key, ds);  throw "e";  }  os.push(val);  }
				else if(op=="where"){  var key=os.pop().val.slice(1), dct=PSI.where(key,ds);   //console.log(dct);
					if(dct!=null) os.push({typ:"dict",val:dct});  os.push({typ:"boolean",val:dct!=null});  }
				else if(op=="store"){
					var val=os.pop(), key=os.pop().val.slice(1), dct=PSI.where(key,ds);   //console.log(dct, key);  throw "e";
					if(dct==null) dct=ds[ds.length-1];  dct[key]=val;  }
				else if(op=="repeat" ) {
					var proc=os.pop(), intg=os.pop().val;
					es.push({typ:"name",val:op+"---", ctx:{ proc:proc, cur:0, cnt:intg }});
				}
				else if(op=="repeat---") {
					var ctx = tok.ctx;
					if(ctx.cur<ctx.cnt) {  es.push(tok);  PSI.addProc(ctx.proc, es);  ctx.cur++;  }
				}
				else if(op=="for" ) {
					var proc=os.pop(), liV=os.pop(), icV=os.pop(), itV=os.pop();
					es.push({typ:"name",val:op+"---", ctx:{  proc:proc, isInt:(itV.typ=="integer" && icV.typ=="integer"), 
								init:itV.val, inc:icV.val, limit:liV.val  }});
				}
				else if(op=="for---") {
					var ctx = tok.ctx;
					if(ctx.isInt) {
						if((ctx.inc>0 && ctx.init<=ctx.limit) || (ctx.inc<0 && ctx.init>=ctx.limit)) {
							es.push(tok);  PSI.addProc(ctx.proc, es);  
							os.push({typ:"integer",val:ctx.init});  ctx.init+=ctx.inc;
						}
					}
					else {
						var lf = new Float32Array(1);
						lf[0]=ctx.limit;  ctx.limit=lf[0];
						lf[0]=ctx.inc  ;  ctx.inc  =lf[0];
						lf[0]=ctx.init;
						if((ctx.inc>0 && lf[0]<=ctx.limit)  ||  (ctx.inc<0 && lf[0]>=ctx.limit)) { 
							es.push(tok);  PSI.addProc(ctx.proc, es);  
							os.push({typ:"real",val:lf[0]});  lf[0]+=ctx.inc;  ctx.init=lf[0];
						}
					}
				}
				else if(op=="loop" ) {
					var proc=os.pop();
					es.push({typ:"name",val:op+"---", ctx:{ proc:proc }});
				}
				else if(op=="loop---") {
					var ctx = tok.ctx;
					PSI.addProc(ctx.proc, es);
				}
				else if(op=="forall") {
					var proc = os.pop(), obj = os.pop();
					es.push({typ:"name",val:op+"---",ctx:[proc,obj,0]});
				}
				else if(op=="forall---") {
					var ctx=tok.ctx, proc=ctx[0],obj=ctx[1],i=ctx[2];
					if(obj.typ=="dict") {
						throw "e";
						for(var p in obj.val) {  PSI.addProcedure(proc.val, file);  PSI.addProcedure([obj.val[p]], file);  }
					}
					else if(obj.typ=="procedure" || obj.typ=="array") {
						if(i<obj.val.length) {
							es.push(tok);  PSI.addProc(proc, es);  
							os.push(obj.val[i]);  ctx[2]++;
						}
						//for(var i=obj.val.length-1; i>=0; i--) {  PSI.addProcedure(proc.val, file);  PSI.addProcedure([obj.val[i]], file);  }
					}
					else {  console.log(proc, obj);  throw "forall: unknown type: "+obj.typ;  }
				}
				else if(op=="exit") {
					var i = es.length-1;
					while(es[i].typ!="name" || !es[i].val.endsWith("---")) i--;
					while(es.length>i) es.pop();
					//console.log(es,i);  throw "e";
				}
				else if(op=="bind") {  
				
					/* var v=os.pop(), prc=v.val;  os.push(v); 
					for(var i=0; i<prc.length; i++){
						var nop = PSI.getOperator(prc[i].val, ds);	 
						//if(nop!=null) prc[i]=nop;  // missing !!!
					}*/
				}
				else if(op=="xcheck") {
					var obj = os.pop(), typ=obj.typ;
					os.push({typ:"boolean",val:(typ=="procedure")});
					//console.log(obj);  throw "e";
				}
				else if(op=="save"    ) {  os.push({typ:"state",val:JSON.parse(JSON.stringify(gst))});   }
				else if(op=="restore" ) {  gst = env.gst = os.pop().val;  }
				else if(op=="gsave"   ) {  gs.push(JSON.parse(JSON.stringify(gst)));  }
				else if(op=="grestore") {  gst = env.gst = gs.pop();  }
				else if(op=="usertime" || op=="realtime") os.push({typ:"integer",val:(op=="usertime"?(Date.now()-otime):Date.now())});
				else if(op=="flush" || op=="readonly") {}
				else if(op=="filter") {
					var fname = os.pop().val.slice(1), sarr;
					if(fname=="ASCII85Decode") {
						var sfile = os.pop().val;   sarr = PSI.F.ASCII85Decode(sfile);
					}
					else if(fname=="RunLengthDecode") {
						var sfile = os.pop().val;   sarr = PSI.F.RunLengthDecode(sfile);
					}
					else throw fname;
					os.push({typ:"file", val:{buff:sarr, off:0, stk:[], env:{pckn:false}}});
				}
				else if(op=="begincmap" || op=="endcmap") {}
				else if(op=="begincodespacerange"||op=="beginbfrange"||op=="beginbfchar") {  env.cmnum = os.pop().val;  }
				else if(op=="endcodespacerange"  ||op=="endbfrange"  ||op=="endbfchar"  ) {
					var cl = (op=="endbfrange"?3:2);
					var pn = op.slice(3), dct = ds[ds.length-1], bpc=0;
					if(dct[pn]==null) dct[pn]=[];
					for(var i=0; i<env.cmnum; i++) {
						var vs=[];  
						for(var j=cl-1; j>=0; j--) {  
							var ar=os.pop(), av=ar.val, nv;
							if(ar.typ=="string") {  nv = PSI.strToInt(av);  if(j==0) bpc=av.length;  }
							else {  nv = [];  for(var k=0; k<av.length; k++) nv.push(PSI.strToInt(av[k].val));  }
							vs[j]=nv;
						}
						dct[pn] = dct[pn].concat(vs);
					}
					if(op!="endcodespacerange") dct["bpc"] = bpc; // bytes per input character
				}
				else if(Oprs) Oprs(op, os, ds, es, gs, env, genv);
				else {  console.log(val, op);  console.log(ds, os);  throw "e";  }
			}
		}
		return true;
	}
	PSI.strToInt = function(str)  {  var v=0;  for(var i=0; i<str.length; i++) v = (v<<8)|str[i];  return v;  }

	
	PSI.F = {
		ASCII85Decode : function(file) {
			var pws = [85*85*85*85, 85*85*85, 85*85, 85, 1];
			var arr = [], i=0, tc=0, off=file.off;
			while(true) {
				if(off>=file.buff.length)  throw "e";
				var cc = file.buff[off];  off++;
				if(PSI.isWhite(cc))  continue;
				if(cc==126) {
					if(i!=0) {
						if(i==3) {  arr.push(((tc>>>24)&255));                   }
						if(i==4) {  arr.push(((tc>>>24)&255), ((tc>>>16)&255));    }
						var lb = (5-i)<<3;  // i=2: 24, i=3: 16 ...
						var nn=((tc>>>lb)&255);  tc=(tc&((1<<lb)-1));  if(tc!=0)nn++;  arr.push(nn);
					}
					file.off=off+1;  //console.log(arr.join(","));  
					return new Uint8Array(arr);  
				}
				if(cc<33 || cc-33>84) throw "e";
				tc += (cc-33)*pws[i];  i++;
				if(i==5) {
					arr.push((tc>>>24)&255);  arr.push((tc>>>16)&255);
					arr.push((tc>>> 8)&255);  arr.push((tc>>> 0)&255);
					i=0;  tc=0;
				}
			}
		},
		RunLengthDecode : function(file) {
			var arr = [], off=file.off;
			while(true) {
				if(off>=file.buff.length)  {  console.log(arr);  throw "e";  }
				var cc = file.buff[off];  off++;
				if(cc==128) {  file.off=off;  return new Uint8Array(arr);  }
				if(cc< 128) {  for(var i=0; i<cc+1  ; i++) arr.push(file.buff[off+i]);  off+=cc+1;  }
				else        {  for(var i=0; i<257-cc; i++) arr.push(file.buff[off]  );  off++;      }
			}
		},
		FlateDecode : function(file) {
			var b = file.buff, ub = new Uint8Array(b.buffer,file.off,b.length);  //console.log(ub);
			var bytes = pako["inflate"](ub);
			return bytes;
		}
	}
	
	PSI.G = {
		concat : function(p,r) {
			for(var i=0; i<r.cmds.length; i++) p.cmds.push(r.cmds[i]);
			for(var i=0; i<r.crds.length; i++) p.crds.push(r.crds[i]);
		},
		getBB  : function(ps) {
			var x0=1e99, y0=1e99, x1=-x0, y1=-y0;
			for(var i=0; i<ps.length; i+=2) {  var x=ps[i],y=ps[i+1];  if(x<x0)x0=x; else if(x>x1)x1=x;  if(y<y0)y0=y;  else if(y>y1)y1=y;  }
			return [x0,y0,x1,y1];
		},
		newPath: function(gst    ) {  gst.pth = {cmds:[], crds:[]};  },
		moveTo : function(gst,x,y) {  var p=PSI.M.multPoint(gst.ctm,[x,y]);  //if(gst.cpos[0]==p[0] && gst.cpos[1]==p[1]) return;
										gst.pth.cmds.push("M");  gst.pth.crds.push(p[0],p[1]);  gst.cpos = p;  },
		lineTo : function(gst,x,y) {  var p=PSI.M.multPoint(gst.ctm,[x,y]);  if(gst.cpos[0]==p[0] && gst.cpos[1]==p[1]) return;
										gst.pth.cmds.push("L");  gst.pth.crds.push(p[0],p[1]);  gst.cpos = p;  },
		curveTo: function(gst,x1,y1,x2,y2,x3,y3) {   var p;  
			p=PSI.M.multPoint(gst.ctm,[x1,y1]);  x1=p[0];  y1=p[1];
			p=PSI.M.multPoint(gst.ctm,[x2,y2]);  x2=p[0];  y2=p[1];
			p=PSI.M.multPoint(gst.ctm,[x3,y3]);  x3=p[0];  y3=p[1];  gst.cpos = p;
			gst.pth.cmds.push("C");  
			gst.pth.crds.push(x1,y1,x2,y2,x3,y3);  
		},
		closePath: function(gst  ) {  gst.pth.cmds.push("Z");  },
		arc : function(gst,x,y,r,a0,a1, neg) {
			
			// circle from a0 counter-clock-wise to a1
			if(neg) while(a1>a0) a1-=2*Math.PI;
			else    while(a1<a0) a1+=2*Math.PI;
			var th = (a1-a0)/4;
			
			var x0 = Math.cos(th/2), y0 = -Math.sin(th/2);
			var x1 = (4-x0)/3, y1 = y0==0 ? y0 : (1-x0)*(3-x0)/(3*y0);
			var x2 = x1, y2 = -y1;
			var x3 = x0, y3 = -y0;
			
			var p0 = [x0,y0], p1 = [x1,y1], p2 = [x2,y2], p3 = [x3,y3];
			
			var pth = {cmds:[(gst.pth.cmds.length==0)?"M":"L","C","C","C","C"], crds:[x0,y0,x1,y1,x2,y2,x3,y3]};
			
			var rot = [1,0,0,1,0,0];  PSI.M.rotate(rot,-th);
			
			for(var i=0; i<3; i++) {
				p1 = PSI.M.multPoint(rot,p1);  p2 = PSI.M.multPoint(rot,p2);  p3 = PSI.M.multPoint(rot,p3);
				pth.crds.push(p1[0],p1[1],p2[0],p2[1],p3[0],p3[1]);
			}
			
			var sc = [r,0,0,r,x,y];  
			PSI.M.rotate(rot, -a0+th/2);  PSI.M.concat(rot, sc);  PSI.M.multArray(rot, pth.crds);
			PSI.M.multArray(gst.ctm, pth.crds);
			
			PSI.G.concat(gst.pth, pth);
			var y=pth.crds.pop();  x=pth.crds.pop();
			gst.cpos = [x,y];
		}
	}
	PSI.M = {
		getScale : function(m) {  return Math.sqrt(Math.abs(m[0]*m[3]-m[1]*m[2]));  },
		translate: function(m,x,y) {  PSI.M.concat(m, [1,0,0,1,x,y]);  },
		rotate   : function(m,a  ) {  PSI.M.concat(m, [Math.cos(a), -Math.sin(a), Math.sin(a), Math.cos(a),0,0]);  },
		scale    : function(m,x,y) {  PSI.M.concat(m, [x,0,0,y,0,0]);  },
		concat   : function(m,w  ) {  
			var a=m[0],b=m[1],c=m[2],d=m[3],tx=m[4],ty=m[5];
			m[0] = (a *w[0])+(b *w[2]);       m[1] = (a *w[1])+(b *w[3]);
			m[2] = (c *w[0])+(d *w[2]);       m[3] = (c *w[1])+(d *w[3]);
			m[4] = (tx*w[0])+(ty*w[2])+w[4];  m[5] = (tx*w[1])+(ty*w[3])+w[5]; 
		},
		invert   : function(m    ) {  
			var a=m[0],b=m[1],c=m[2],d=m[3],tx=m[4],ty=m[5], adbc=a*d-b*c;
			m[0] = d/adbc;  m[1] = -b/adbc;  m[2] =-c/adbc;  m[3] =  a/adbc;
			m[4] = (c*ty - d*tx)/adbc;  m[5] = (b*tx - a*ty)/adbc;
		},
		multPoint: function(m, p ) {  var x=p[0],y=p[1];  return [x*m[0]+y*m[2]+m[4],   x*m[1]+y*m[3]+m[5]];  },
		multArray: function(m, a ) {  for(var i=0; i<a.length; i+=2) {  var x=a[i],y=a[i+1];  a[i]=x*m[0]+y*m[2]+m[4];  a[i+1]=x*m[1]+y*m[3]+m[5];  }  }
	}
	PSI.C = {
		srgbGamma : function(x) {  return x < 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1.0 / 2.4) - 0.055;  },
		cmykToRgb : function(clr) { 
			var c=clr[0], m=clr[1], y=clr[2], k=clr[3];
			var r = 255
			+ c * (-4.387332384609988  * c + 54.48615194189176  * m +  18.82290502165302  * y + 212.25662451639585 * k +  -285.2331026137004) 
			+ m * ( 1.7149763477362134 * m - 5.6096736904047315 * y + -17.873870861415444 * k - 5.497006427196366) 
			+ y * (-2.5217340131683033 * y - 21.248923337353073 * k +  17.5119270841813) 
			+ k * (-21.86122147463605  * k - 189.48180835922747);
			var g = 255
			+ c * (8.841041422036149   * c + 60.118027045597366 * m +  6.871425592049007  * y + 31.159100130055922 * k +  -79.2970844816548) 
			+ m * (-15.310361306967817 * m + 17.575251261109482 * y +  131.35250912493976 * k - 190.9453302588951) 
			+ y * (4.444339102852739   * y + 9.8632861493405    * k -  24.86741582555878) 
			+ k * (-20.737325471181034 * k - 187.80453709719578);
			var b = 255
			+ c * (0.8842522430003296  * c + 8.078677503112928  * m +  30.89978309703729  * y - 0.23883238689178934 * k + -14.183576799673286) 
			+ m * (10.49593273432072   * m + 63.02378494754052  * y +  50.606957656360734 * k - 112.23884253719248) 
			+ y * (0.03296041114873217 * y + 115.60384449646641 * k + -193.58209356861505)
			+ k * (-22.33816807309886  * k - 180.12613974708367);

			return [Math.max(0, Math.min(1, r/255)), Math.max(0, Math.min(1, g/255)), Math.max(0, Math.min(1, b/255))];
			//var iK = 1-c[3];  
			//return [(1-c[0])*iK, (1-c[1])*iK, (1-c[2])*iK];  
		},
		labToRgb  : function(lab) {
			var k = 903.3, e = 0.008856, L = lab[0], a = lab[1], b = lab[2];
			var fy = (L+16)/116, fy3 = fy*fy*fy;
			var fz = fy - b/200, fz3 = fz*fz*fz;
			var fx = a/500 + fy, fx3 = fx*fx*fx;
			var zr = fz3>e ? fz3 : (116*fz-16)/k;
			var yr = fy3>e ? fy3 : (116*fy-16)/k;
			var xr = fx3>e ? fx3 : (116*fx-16)/k;
				
			var X = xr*96.72, Y = yr*100, Z = zr*81.427, xyz = [X/100,Y/100,Z/100];
			var x2s = [3.1338561, -1.6168667, -0.4906146, -0.9787684,  1.9161415,  0.0334540, 0.0719453, -0.2289914,  1.4052427];
			
			var rgb = [ x2s[0]*xyz[0] + x2s[1]*xyz[1] + x2s[2]*xyz[2],
						x2s[3]*xyz[0] + x2s[4]*xyz[1] + x2s[5]*xyz[2],
						x2s[6]*xyz[0] + x2s[7]*xyz[1] + x2s[8]*xyz[2]  ];
			for(var i=0; i<3; i++) rgb[i] = Math.max(0, Math.min(1, PSI.C.srgbGamma(rgb[i])));
			return rgb;
		}
	}
	PSI.B = {
		readUshort : function(buff,p)  {  return (buff[p]<< 8) | buff[p+1];  },
		readUint   : function(buff,p)  {  return (buff[p]*(256*256*256)) + ((buff[p+1]<<16) | (buff[p+2]<< 8) | buff[p+3]);  },
		readASCII  : function(buff,p,l){  var s = "";  for(var i=0; i<l; i++) s += String.fromCharCode(buff[p+i]);  return s;    }
	}
	
	PSI.nrm = function(v) {  return Math.max(0,Math.min(1,v));  }
	PSI.makeArr = function(a,typ) {  var na=[];  for(var i=0; i<a.length; i++) na.push({typ:typ,val:a[i]});  return na;  }
	PSI.readArr = function(a    ) {  var na=[];  for(var i=0; i<a.length; i++) na.push(a[i].val          );  return na;  }
	PSI.readStr = function(a    ) {  var s ="";  for(var i=0; i<a.length; i++) s+=String.fromCharCode(a[i]); return s;   }

	PSI.getFromStacks = function(name, ds)
	{
		//console.log(ds);
		var di = ds.length-1;
		while(di>=0) {  if(ds[di][name]!=null) return ds[di][name];  di--;  }
		return null;
	}
	PSI.where = function(name, ds)
	{
		var di = ds.length-1;
		while(di>=0) {  if(ds[di][name]!=null) return ds[di]      ;  di--;  }
		return null;
	}
	
	
	
	
	
	
	
	PSI.skipWhite = function(file) {
		var i = file.off, buff=file.buff, isWhite = PSI.isWhite;
		
		while(isWhite(buff[i]) || buff[i]==37) {
			while(isWhite(buff[i])) i++;	// not the first whitespace
			if(buff[i]==37) {  while(i<buff.length && !PSI.isEOL(buff[i])) i++;  i++;  }	// comments
		}
		file.off = i;
	}
	
	
	
	PSI.getToken = function(es, ds) {
		if(es.length==0) return null;
		var src = es[es.length-1];
		if(src.typ=="procedure") {
			var tok = src.val[src.off];  src.off++;
			if(src.off==src.val.length) es.pop();
			return tok;
		}
		if(src.typ=="name") {  es.pop();  return src;  }
		
		var ftok = PSI.getFToken(src.val, ds);
		if(ftok==null) {  es.pop();  if(es.length!=0) ftok = PSI.getFToken(es[es.length-1].val, ds);  }
		return ftok;
	}
	
	PSI.getFToken = function(file, ds) {
		PSI.skipWhite(file);
		
		var isWhite = PSI.isWhite, isSpecl = PSI.isSpecl;
		var i = file.off, buff=file.buff, tok = null;
		if(i>=buff.length) return null;
		
		var cc = buff[i], ch = String.fromCharCode(cc);  i++;
			
		if(ch=="(") {  
			var dpth=0, end=i;
			while(!(buff[end]==41 && dpth==0)) {  if(buff[end]==40) dpth++;  if(buff[end]==41) dpth--;  if(buff[end]==92) end++;   end++;  }
			var str = []; 
			for(var j=0; j<end-i; j++) str.push(buff[i+j]);
			i = end+1;
			str = PSI.getString(str);
			tok = {typ:"string", val:str};
		}
		else if(ch=="{" || ch=="}" || ch=="[" || ch=="]") {  tok = {typ:"name", val:ch};  }
		else if((ch=="<" && buff[i]==60) || (ch==">" && buff[i]==62)) {  tok = {typ:"name", val:ch=="<" ? "<<" : ">>"};  i++;  }
		else if(ch=="<") {
			var end = i;  while(buff[end]!=62) end++;  
			var str = PSI.readHex({buff:buff,off:i},(end-i)>>>1);
			tok = {typ:"string",val:str};  i = end+1;
		}
		else {
			var end = i;
			while(end<buff.length && !isWhite(buff[end]) && (!isSpecl(buff[end]) || (buff[end]==47&&buff[end-1]==47&&end==i) )) end++;  // read two slashes
			var name = PSI.B.readASCII(buff, i-1, end-i+1);
			i = end;
			var num = parseFloat(name);
			if(false) {}
			else if(name=="true" || name=="false") tok = {typ:"boolean", val:name=="true"};
			else if(!isNaN(num)) {
				var f32 = new Float32Array(1);  f32[0]=num;  num=f32[0];
				tok = {typ:name.indexOf(".")==-1?"integer":"real", val:num};
			}
			else {  
				if(name.slice(0,2)=="//") {
					var nn = name.slice(2);
					var sbs = PSI.getFromStacks(nn, ds);
					if(sbs==null) throw "e";
					tok = sbs;
				}
				else tok = {typ:"name", val:name};    
			}
		}
		file.off = i;
		
		return tok;
	}
	// ( ) < >     [ ] { }  %  /
	PSI.isSpecl = function(cc) {  return [ 40,41, 60,62,   91,93, 123,125,  37,  47   ].indexOf(cc)!=-1;  }
	PSI.isWhite = function(cc) {  return cc==9 || cc==10 || cc==12 || cc==13 || cc==32;  }
	PSI.isEOL   = function(cc) {  return cc==10 || cc==13;  }
	
	PSI.getString = function(str) {  
		var s=[];  
		var m0 = ["n" , "r" , "t" , "b" , "f" , "\\", "(", ")", " ", "/"];
		var m1 = ["\n", "\r", "\t", "", "", "\\", "(", ")", " ", "/"];
		
		for(var i=0; i<str.length; i++) {
			var cc = str[i], ch = String.fromCharCode(cc);
			if(ch=="\\") {
				var nx = String.fromCharCode(str[i+1]);  i++;
				if(nx=="\r" || nx=="\n") continue;
				var idx = m0.indexOf(nx);
				if(idx!=-1) s.push(m1[idx].charCodeAt(0));
				else {
					var cod = nx + String.fromCharCode(str[i+1]) + String.fromCharCode(str[i+2]);  i+=2;
					s.push(parseInt(cod,8));
				}
			}
			else s.push(cc);  
		}
		return s;  
	}
	PSI.makeString = function(arr) {
		var m0 = ["n" , "r" , "t" , "b" , "f" , "\\", "(", ")"];
		var m1 = ["\n", "\r", "\t", "", "", "\\", "(", ")"];
		var out = [];
		for(var i=0; i<arr.length; i++) {
			var b = arr[i];
			var mi = m1.indexOf(String.fromCharCode(b));
			if(mi==-1) out.push(b);
			else out.push(92, m0[mi].charCodeAt(0));
		}
		return out;
	}
	PSI.readHex = function(fl, l)
	{
		var i=0, j=-1, val=[];
		while(true) {
			var cc = fl.buff[fl.off];  fl.off++;
			var ci=0;
			if(47<cc && cc<58) ci=cc-48;
			else if(96<cc && cc<103) ci=10+cc-97;
			else if(64<cc && cc<71 ) ci=10+cc-65;
			else continue;
			if(j==-1) j=ci;
			else {  val[i]=(j<<4)|ci;  j=-1;  i++;  if(i==l) break;  }
		}
		return val;
	}
	
		
	
	
	
	function PDFI ()
	{
	}
	
	PDFI.Parse = function(buff, genv)
	{
		buff = new Uint8Array(buff);
		var off = 0;
		while(buff[off]==32) off++;
		if(off!=0) buff = new Uint8Array(buff.buffer, off, buff.length-off);
		
		var offset = buff.length-3;
		while(PSI.B.readASCII(buff,offset,3) != "%%E") offset--;
		
		var eoff = offset;
		
		offset--;
		while( PSI.isEOL(buff[offset])) offset--;
		while(!PSI.isEOL(buff[offset])) offset--;
		
		var xref = parseInt(PSI.B.readASCII(buff, offset+1, eoff-offset-1));
		
		if(isNaN(xref)) throw "e";
		
		var xr = [];
		var tr = PDFI.readXrefTrail(buff, xref, xr);
		
		//console.log(xr);
		
		var file = {buff:buff, off:0}, rt = tr["/Root"];
		if(rt.typ=="ref") tr["/Root"] = PDFI.getIndirect(rt.ind,rt.gen,file,xr)
		var ps = tr["/Root"]["/Pages"];
		if(ps.typ=="ref") tr["/Root"]["/Pages"] = PDFI.getIndirect(ps.ind,ps.gen,file,xr)
		
		//console.log(tr);
		
		var stk = [tr["/Root"]["/Pages"]];
		
		while(stk.length!=0) {
			var pg = stk.pop();
			if(pg["/Type"]=="/Pages") {
				var ks = pg["/Kids"];
				for(var i=0; i<ks.length; i++) {
					if(ks[i].typ=="ref") ks[i] = PDFI.getIndirect(ks[i].ind,ks[i].gen,file,xr)
					stk.push(ks[i]);
				}
			}
		}
		
		var time = Date.now();
		PDFI.render(tr["/Root"], genv);
		genv.Done();
		//console.log(Date.now()-time);
	}
	PDFI.render = function(root, genv)
	{
		var rbb = root["/Pages"]["/MediaBox"];
		
		var ops = [
			"CS","cs","SCN","scn","SC","sc","sh",
			"Do", "gs", "ID","EI", "re","cm","y","v","B","B*",  "BT","ET",
			"Tj","TJ","Tf","Tm","Td","T*",
			"Tc","Tw","Tz","TL","Tr","Ts",
			"MP","DP","BMC","BDC","EMC","BX","EX",  "ri"
		];
		
		var prcs = {
			"J":"setlinecap",
			"j":"setlinejoin",
			"w":"setlinewidth",
			"d":"setdash",
			"M":"setmiterlimit",
			"i":"setflat",
			"q":"gsave",  "Q":"grestore",
			"m":"moveto",  "l":"lineto",  "c":"curveto", "h":"closepath",
			"W":"clip",  "W*":"eoclip",
			"f":"fill","F":"fill","f*":"eofill", "S":"stroke",  "b":"h B", "b*":"h B*",
			"n":"newpath",
			
			"RG" : "/DeviceRGB  CS SCN",
			"rg" : "/DeviceRGB  cs scn",
			"G"  : "/DeviceGray CS SCN",
			"g"  : "/DeviceGray cs scn",
			"K"  : "/DeviceCMYK CS SCN",
			"k"  : "/DeviceCMYK cs scn",
			
			"TD" : "dup neg TL Td",
			"\"" : "exch Tc exch Tw '",
			"'"  : "T* Tj",
			
			"s"  : "h S",
			"BI" : "/BI"
		}
		prcs = PSI.makeProcs(prcs);
		
		var stk = [root["/Pages"]], pi=0;
		
		while(stk.length!=0) {
			var pg = stk.pop();
			
			if(pg["/Type"]=="/Pages") {
				var ks = pg["/Kids"];
				for(var i=ks.length-1; i>=0; i--) stk.push(ks[i]);
				continue;
			}
			pi++;  //if(pi!=2) continue;  
			
			var cts = pg["/Contents"];   //console.log(pg);
			if(cts.length==null) cts = [cts];
			
			var bb = pg["/MediaBox"];  if(bb==null) bb = rbb;
			var env = PSI._getEnv(bb);  env.pgOpen = true;
			var gs = [];
			var os = [];	// operand stack
			var ds = PSI._getDictStack(ops, prcs);
			var es = [];
			
			genv.StartPage(bb[0],bb[1],bb[2],bb[3]);
			for(var j=0; j<cts.length; j++)
			{
				var cnt = cts[j]["stream"];
				//console.log(PSI.B.readASCII(cnt,0,cnt.length));
				es.push({  typ:"file", val: {  buff:cnt, off:0, extra:pg  }  });	// execution stack
				var repeat = true;
				while(repeat) repeat = PSI.step(os, ds, es, gs, env, genv, PDFI.operator);
			}
			genv.ShowPage();  //if(pi>23) break;
		}
	}
	PDFI.operator = function(op, os, ds, es, gs, env, genv)
	{
		//console.log(op);
		var gst = env.gst;
		var lfi = es.length-1;  while(es[lfi].typ!="file") lfi--;
		var fle = es[lfi].val;
		var res = fle.extra["/Resources"];
		if(op=="Do") {
			var nam = os.pop().val, xo = res["/XObject"][nam];
			//console.log(xo);
			var st=xo["/Subtype"], stm = xo["stream"];
			if(st=="/Form")  {
				//console.log(PSI.B.readASCII(stm,0,stm.length));
				es.push( {typ:"file", val: { buff:stm, off:0, extra:xo }}  );
			}
			else if(st=="/Image")  {
				var sms = null;  //console.log(xo);
				if(xo["/SMask"]) sms = PDFI.getImage(xo["/SMask"], gst);
				var w=xo["/Width"], h=xo["/Height"], cs=xo["/ColorSpace"];
				var img = PDFI.getImage(xo, gst);
				if(xo["/ImageMask"]==true) {
					sms = img;
					img = new Uint8Array(w*h*4), r0 = gst.colr[0]*255, g0 = gst.colr[1]*255, b0 = gst.colr[2]*255;
					for(var i=0; i<w*h*4; i+=4) {  img[i]=r0;  img[i+1]=g0;  img[i+2]=b0;  img[i+3]=255;  }
				}
				genv.PutImage(gst, img, w,h, sms);
			}
			else console.log("Unknown XObject",st);
		}
		else if(op=="gs") {
			var nm = os.pop().val;
			var egs = res["/ExtGState"][nm];
			for(var p in egs) {
				var v = egs[p];
				if(p=="/Type") continue;
				else if(p=="/CA") gst.CA=v;
				else if(p=="/ca") gst.ca=v;
				else if(p=="/BM") gst.bmode = v;
				else if(p=="/LC") gst.lcap  = v;
				else if(p=="/LJ") gst.ljoin = v;
				else if(p=="/LW") gst.lwidth = v;
				else if(p=="/ML") gst.mlimit = v;
				else if(p=="/SA") gst.SA = v;
				else if(p=="/OPM")gst.OPM = v;
				else if(p=="/AIS")gst.AIS = v;
				else if(p=="/OP") gst.OP = v;
				else if(p=="/op") gst.op = v;
				else if(p=="/SMask") {  gst.SMask = "";  }
				else if(p=="/SM") gst.SM = v;
				else if(p=="/BG" || p=="/HT" || p=="/TR" || p=="/UCR") {}
				else console.log("Unknown gstate property: ", p, v);
			}
		}
		else if(op=="ID") {
			var dic = {};
			while(true) {  var v = os.pop().val;  if(v=="/BI") break;  dic[os.pop().val] = v;  }    fle.off++;
			var w=dic["/W"], h=dic["/H"], ar=w*h, img = new Uint8Array(ar*4), cs = dic["/CS"], bpc = dic["/BPC"];
			var end = fle.off;
			while(!PSI.isWhite(fle.buff[end]) || fle.buff[end+1]!=69 || fle.buff[end+2]!=73) end++;
			var stm = fle.buff.slice(fle.off, end);  fle.off+=stm.length;
			if(dic["/F"]=="/Fl") {  stm = PSI.F.FlateDecode({buff:stm, off:0});  delete dic["/F"];  }
			if(cs=="/G" && dic["/F"]==null) {
				PDFI.plteImage(stm, 0, img, null, w, h, bpc);
			}
			else if(cs[0].typ!=null) {
				PDFI.plteImage(stm, 0, img, cs[3].val, w, h, bpc);
			}
			else img = stm;
			genv.PutImage(gst, img, w,h);
		}
		else if(op=="n" || op=="BT" || op=="EI") {}
		else if(op=="ET") {  gst.font.Tm = [1,0,0,1,0,0];  gst.font.Tlm=gst.font.Tm.slice(0);  }
		else if(op=="re") {
			var h=os.pop().val, w=os.pop().val, y=os.pop().val, x=os.pop().val;
			PSI.G.moveTo(gst,x,y);  PSI.G.lineTo(gst,x+w,y);  PSI.G.lineTo(gst,x+w,y+h);  PSI.G.lineTo(gst,x,y+h);  PSI.G.closePath(gst);
		}
		else if(op=="y" || op=="v") {
			var im=gst.ctm.slice(0);  PSI.M.invert(im);  var p=PSI.M.multPoint(im,gst.cpos);  
			var y3=os.pop().val, x3=os.pop().val, y1=os.pop().val, x1=os.pop().val;
			if(op=="y") PSI.G.curveTo(gst,x1,y1,x3,y3,x3,y3);
			else        PSI.G.curveTo(gst,p[0],p[1],x1,y1,x3,y3);
		}
		else if(op=="B" || op=="B*") {
			genv.Fill(gst, op=="B*");    //PSI.G.newPath(gst);
			genv.Stroke(gst);  PSI.G.newPath(gst);
		}
		else if(op=="cm" || op=="Tm") {
			var m = [];  for(var i=0; i<6; i++) m.push(os.pop().val);    m.reverse();  
			
			if(op=="cm") {  PSI.M.concat(m, gst.ctm);  gst.ctm = m;    }
			else         {  gst.font.Tm = m;  gst.font.Tlm = m.slice(0);  }
		}
		else if(op=="Td" || op=="T*") {
			var x=0, y=0;
			if(op=="T*") { x=0; y=-gst.font.Tl; }
			else { y=os.pop().val;  x=os.pop().val; }
			var tm = [1,0,0,1,x,y];  PSI.M.concat(tm,gst.font.Tlm);
			gst.font.Tm = tm;  gst.font.Tlm = tm.slice(0);
		}
		else if(op=="Tf") {
			var sc = os.pop().val, fnt = os.pop().val;
			gst.font.Tf=fnt;//rfnt["/BaseFont"].slice(1);
			gst.font.Tfs=sc;  //os.push(fnt);
		}
		else if(op=="Tj" || op=="TJ") {
			var sar = os.pop();
			if(sar.typ=="string") sar = [sar];
			else sar = sar.val;
			
			var rfnt = res["/Font"][fnt];
			
			var tf = gst.font.Tf;
			var fnt = res["/Font"][tf];
			var scl = PSI.M.getScale(gst.font.Tm)*gst.font.Tfs/1000;
			
			for(var i=0; i<sar.length; i++) {
				//if(sar[i].typ!="string") {  gst.font.Tm[4] += -scl*sar[i].val;  continue;  }
				if(sar[i].typ!="string") {  if(i==0) gst.font.Tm[4] += -scl*sar[i].val;  continue;  }
				var str = PDFI.getString(sar[i].val, fnt);
				if(sar[i+1] && sar[i+1].typ!="string") {  var sv = sar[i+1].val;  str[1] += -sv;  if(-900<sv && sv<-100) str[0]+=" ";  }
				
				gst.font.Tf = str[2];
				genv.PutText(gst, str[0], str[1]/1000);  //gst.cpos[0] += str.length*gst.font.mat[0]*0.5;  
				gst.font.Tf = tf;
				gst.font.Tm[4] += scl*str[1];
			}
		}
		else if(op=="Tc") gst.font.Tc = os.pop().val;
		else if(op=="Tw") gst.font.Tw = os.pop().val;
		else if(op=="Tz") gst.font.Th = os.pop().val;
		else if(op=="TL") gst.font.Tl = os.pop().val;
		else if(op=="Tr") gst.font.Tmode = os.pop().val;
		else if(op=="Ts") gst.font.Trise = os.pop().val;
		else if(op=="CS"  || op=="cs" ) {  var cs = os.pop().val;  if(op=="CS") gst.sspace=cs;  else gst.space=cs;  }
		else if(op=="SCN" || op=="scn" || op=="SC" || op=="sc") {
			var stk = (op=="SCN" || op=="SC");
			var csi =  stk ? gst.sspace : gst.space, cs, c = null;
			//console.log(op, cs, os);  throw "e";
			var sps = res ? res["/ColorSpace"] : null;  //if(sps!=null) console.log(sps[csi]);
			if(sps!=null && sps[csi]!=null) {
				if(sps[csi][1] && sps[csi][1]["/Alternate"])  cs = sps[csi][1]["/Alternate"];  //cs = sps[csi][0];
				else cs = (typeof sps[csi] == "string") ? sps[csi] : sps[csi][0];
			}
			else cs = csi;
			//console.log(res, cs, os.slice(0));
			if(cs=="/Lab" || cs=="/DeviceRGB" || cs=="/DeviceN" || (cs=="/ICCBased" && sps[csi][1]["/N"]==3)) {  
					c=[os.pop().val, os.pop().val, os.pop().val];  c.reverse();  }
			else if(cs=="/DeviceCMYK" || (cs=="/ICCBased" && sps[csi][1]["/N"]==4)) {  
					var cmyk=[os.pop().val,os.pop().val,os.pop().val,os.pop().val];  cmyk.reverse();  c = PSI.C.cmykToRgb(cmyk);  }
			else if(cs=="/DeviceGray" || cs=="/CalGray") {  var gv=PSI.nrm(os.pop().val);  c=[gv,gv,gv];  }
			else if(cs=="/Separation") {  var lab = PDFI.Func(sps[csi][3], [os.pop().val]);  c = PSI.C.labToRgb(lab);  }
			else if(cs=="/Pattern")    {  
				//*
				var pt = res["/Pattern"][os.pop().val];  //console.log(pt);
				var ptyp = pt["/PatternType"];
				if(ptyp==1) {  console.log("tile pattern");  return;  }
				PDFI.setShadingFill(pt["/Shading"], pt["/Matrix"], stk, gst);
				return;//*/  os.pop();  c=[1,0.5,0]; 
			}
			else {  console.log(csi, cs, os, sps, res);  throw("e");  }
			//console.log(c);
			if(stk) gst.COLR = c;  else gst.colr=c;
		}
		else if(op=="sh")  {  //os.pop();  return;
			//if(window.asdf==null) window.asdf=0;
			//window.asdf++;  if(window.asdf!=6) return;
			var sh = res["/Shading"][os.pop().val];  //console.log(sh);
			var ocolr = gst.colr, opth = gst.pth;
			gst.pth = gst.cpth;
			PDFI.setShadingFill(sh, gst.ctm.slice(0), false, gst);
			//console.log(gst);
			genv.Fill(gst);
			gst.colr = ocolr;  gst.pth = opth;
		}
		else if(op=="MP" || op=="BMC" || op=="ri") {  os.pop();  }
		else if(op=="DP" || op=="BDC") {  os.pop();  os.pop();  }
		else if(op=="EMC"|| op=="BX" || op=="EX") {  }
		else 
			throw ("Unknown operator", op);
		
	}

	
	PDFI.setShadingFill = function(sh, mat, stk, gst)
	{
		var styp = sh["/ShadingType"], cs = sh["/ColorSpace"];
		//console.log(cs);
		//if(cs!="/DeviceRGB") throw "unknown shading space " + cs;	
		var ftyp = "";
		if(styp==2) {
			ftyp="lin";
		}
		else if(styp==3) {
			ftyp="rad";
		}
		else {  console.log("Unknown shading type", styp);  return;  }
		
		//console.log(gst);  console.log(sh);
		var fill = {typ:ftyp, mat:mat, grad:PDFI.getGrad(sh["/Function"], cs), crds:sh["/Coords"]}
		
		if(stk) gst.COLR = fill;  else gst.colr=fill;
	}
	
	PDFI.getGrad = function(fn, cs) {
		var F = PDFI._normColor;
		var fs = fn["/Functions"], ft = fn["/FunctionType"], bs = fn["/Bounds"], enc = fn["/Encode"];
		//console.log(fn);
		if(ft==0 || ft==2) return [   [0,F(fn,[0], cs)],  [1,F(fn,[1], cs)]   ];
		var zero = enc[0];
		var grd = [];
		if(bs.length==0 || bs[0]>0) grd.push([0, F(fs[0], [zero], cs)] );
		for(var i=0; i<bs.length; i++)  grd.push([bs[i], F(fs[i],[zero], cs)]);
		if(bs.length==0 || bs[bs.length-1]<1) grd.push([1, F(fs[fs.length-1], [1-zero], cs)]);
		//console.log(fn, grd);
		return grd;
	}
	PDFI._clrSamp = function(stm, i) {  return [stm[i]/255, stm[i+1]/255, stm[i+2]/255];  }
	
	PDFI._normColor = function(fn, vls, cs) {
		var clr = PDFI.Func(fn, vls);
		if(cs[3] && cs[3].stream) {
			clr = PDFI.Func(cs[3], clr);
			//console.log(clr);
			if(cs[2]=="/DeviceCMYK") clr = PSI.C.cmykToRgb(clr);
			else throw "e";
			//console.log(clr);
		}
		//if(clr.length<3) {  console.log(clr.slice(0));  throw "e";  clr.push(1);  }
		return clr;
	}
	
	PDFI.getImage = function(xo, gst) {
		var w=xo["/Width"], h=xo["/Height"], ar = w*h, ft=xo["/Filter"], cs=xo["/ColorSpace"], bpc=xo["/BitsPerComponent"], stm=xo["stream"];
		var img = xo["image"];  //console.log(xo);
		if(img==null) {
			var msk = xo["/Mask"];
			if(cs && cs[0]=="/Indexed") {
				var pte;
				if(cs[3].length!=null) {	// palette in a string
					var str = cs[3];  pte = new Uint8Array(256*3);
					for(var i=0; i<str.length; i++) pte[i] = str.charCodeAt(i);
				}							
				else pte = cs[3]["stream"];
				var nc = new Uint8Array(ar*4);
				PDFI.plteImage(stm, 0, nc, pte, w, h, bpc, msk);
				img=nc;
			}
			else if(ft==null && cs && cs=="/DeviceGray") {
				var pte = [0,0,0,255,255,255], nc = new Uint8Array(ar*4);
				if(xo["/Decode"] && xo["/Decode"][0]==1) {  pte.reverse();  }
				if(xo["/ImageMask"]==true)  pte.reverse();
				PDFI.plteImage(stm, 0, nc, bpc==1?pte:null, w, h, bpc, msk);
				img=nc;
			}
			else if(w*h*3<=stm.length) {
				var nc = new Uint8Array(ar*4);
				for(var i=0; i<ar; i++) {  var ti=i*3, qi=i*4;  nc[qi]=stm[ti];  nc[qi+1]=stm[ti+1];  nc[qi+2]=stm[ti+2];  nc[qi+3]=255;  }
				img = nc;
			}
			else {  img = stm;  }
			xo["image"] = img;
		}
		return img;
	}
	PDFI.plteImage = function(buff, off, img, plt, w, h, bpc, msk)
	{
		var mlt = Math.round(255/((1<<bpc)-1));
		var bpl = Math.ceil(w*bpc/8);
		for(var y=0; y<h; y++) {
			var so = off + bpl * y; 
			for(var x=0; x<w; x++) {  
				var ci = 0;
				if     (bpc==8) ci = buff[so+x];
				else if(bpc==4) ci=(buff[so+(x>>1)]>>((1-(x&1))<<2))&15;
				else if(bpc==2) ci=(buff[so+(x>>2)]>>((3-(x&3))<<1))&3;  
				else if(bpc==1) ci=(buff[so+(x>>3)]>>((7-(x&7))<<0))&1;
				var qi = (y*w+x)<<2;  
				if(plt) {  var c =ci*3;    img[qi]=plt[c];  img[qi+1]=plt[c+1];  img[qi+2]=plt[c+2];  }
				else    {  var nc=ci*mlt;  img[qi]=nc;      img[qi+1]=nc;        img[qi+2]=nc;        }
				img[qi+3]=255;  
				if(msk && msk[0]<=ci && ci<=msk[1]) img[qi+3]=0; 
			}
		}
	}
	
	PDFI.Func = function(f, vls)
	{
		var dom = f["/Domain"], rng = f["/Range"], typ = f["/FunctionType"], out = [];
		for(var i=0; i<vls.length; i++) vls[i]=Math.max(dom[2*i], Math.min(dom[2*i+1], vls[i]));
		if(typ==0) {
			var enc = f["/Encode"], sz = f["/Size"], dec = f["/Decode"], n = rng.length/2;
			if(enc==null) enc=[0,sz[0]-1];
			if(dec==null) dec=[0,sz[0]-1,0,sz[0]-1,0,sz[0]-1];
			
			for(var i=0; i<vls.length; i++) {
				var ei = PDFI.intp(vls[i],dom[2*i],dom[2*i+1],enc[2*i],enc[2*i+1]);
				vls[i] = Math.max(0, Math.min(sz[i]-1, ei));
			}
			for(var j=0; j<n; j++) {
				var x = Math.round(vls[0]), rj = f["stream"][n*x+j];
				rj = PDFI.intp(rj, 0,255, dec[2*j],dec[2*j+1]);
				out.push(rj);
			}
		}
		else if(typ==2) {
			var c0=f["/C0"],c1=f["/C1"],N=f["/N"]
			var x = vls[0];
			for(var i=0; i<c0.length; i++) out[i] = c0[i] + Math.pow(x,N) * (c1[i]-c0[i]);
		}
		else if(typ==4) {
			var env = PSI._getEnv([0,0,0,0]);  env.pgOpen = true;
			var gs = [];
			var os = [];	// operand stack
			var ds = PSI._getDictStack([], {});
			var es = [];
			
			//console.log(PSI.B.readASCII(f["stream"],0,f["stream"].length));
			es.push({  typ:"file", val: {  buff:f["stream"], off:0 }  });	// execution stack
			var repeat = true;
			while(repeat) repeat = PSI.step(os, ds, es, gs, env, {}, PDFI.operator);
			
			var proc = os.pop();  proc.off=0;
			es.push(proc);
			for(var i=0; i<vls.length; i++) os.push({typ:"real",val:vls[i]});
			repeat = true;
			while(repeat) repeat = PSI.step(os, ds, es, gs, env, {}, PDFI.operator);
			for(var i=0; i<os.length; i++) out.push(os[i].val);
		}
		
		if(rng) for(var i=0; i<out.length; i++) out[i]=Math.max(rng[2*i], Math.min(rng[2*i+1], out[i]));
		return out;
	}
	PDFI.intp = function(x,xmin,xmax,ymin,ymax) {  return ymin + (x-xmin) * (ymax-ymin)/(xmax-xmin);  }
	
	PDFI.getString = function(sv, fnt)
	{
		//console.log(sv, fnt);  //throw "e";
		
		var st = fnt["/Subtype"], s="", m=0, psn=null;
		var tou = fnt["/ToUnicode"], enc = fnt["/Encoding"], sfnt=fnt;	// font with a stream
		if(st=="/Type0") sfnt = fnt["/DescendantFonts"][0];  // // only in type 0
		
		if(tou!=null) s = PDFI.toUnicode(sv, tou);
		else if(enc=="/WinAnsiEncoding") s = PDFI.fromWin(sv);
		else if(st=="/Type0") {
			var off=0;
			if(enc=="/Identity-H") off=31;
			for(var j=0; j<sv.length; j+=2) {
				var gid = (sv[j]<<8)|sv[j+1];  //console.log(gid, stm);
				s += String.fromCharCode(gid+off);  // don't know why 31
			}
		}
		else if(enc!=null && enc["/Type"]=="/Encoding") {
			var dfs = enc["/Differences"];
			if(dfs) {
				var s = "";
				for(var i=0; i<sv.length; i++) {
					var ci = sv[i], coff=-5;
					for(var j=0; j<dfs.length; j++)
					{
						if(typeof dfs[j] == "string") {  if(ci==coff) s+=PDFI.fromCName(dfs[j].slice(1));  coff++;  }
						else coff=dfs[j];
					}
				}
			}
			//console.log(enc, sv);	throw "e";
			//s = PDFI.fromWin(sv);
		}
		else {  /*console.log("reading simple string", sv, fnt);*/  s = PSI.readStr(sv);  }
		
		
		if(st=="/Type0") {
			//console.log(fnt);  //throw "e";
			var ws = sfnt["/W"];
			if(ws==null) m = s.length*1000*0.4;
			else
			for(var i=0; i<sv.length; i+=2) {
				var cc = (sv[i]<<8)|sv[i+1], gotW = false;
				for(var j=0; j<ws.length; j+=2) {
					var i0=ws[j], i1 = ws[j+1];
					if(i1.length) {   if(0<=cc-i0 && cc-i0<i1.length) {  m += i1[cc-i0];  gotW=true;  }   }
					else {  if(i0<=cc && cc<=i1) {  m += ws[j+2];  gotW = true;  }  j++;  }
				}
				if(!gotW) m += ws[1][0];
			}
		}
		else if(st=="/Type1" || st=="/TrueType") {
			var fc=fnt["/FirstChar"], ws = fnt["/Widths"];
			if(ws)	for(var i=0; i<sv.length; i++) m += ws[sv[i]-fc];
			else    {  m = s.length*1000*0.4;  console.log("approximating word width");  }
		}
		else throw "e";
		
		//console.log(fnt);//  throw "e";
		//console.log(sfnt);
		var fd = sfnt["/FontDescriptor"];
		if(fd) {
			if(fd["psName"]) psn=fd["psName"];
			else {
				var pp, ps = ["","2","3"];
				for(var i=0; i<3; i++) if(fd["/FontFile"+ps[i]]) pp = "/FontFile"+ps[i];
				if(pp) {
					var fle = fd[pp]["stream"];
					if(pp!=null && fle && PSI.B.readUint(fle,0)==65536) psn = fd["psName"] = PDFI._psName(fle);
				}
			}
		}
		if(psn==null) psn = fnt["/BaseFont"].slice(1);
		return [s, m, psn.split("+").pop()];
	}
	PDFI._psName = function(fle) {
		var rus = PSI.B.readUshort;
		var num = rus(fle, 4);
		
		var noff = 0;
		for(var i=0; i<num; i++) {
			var tn = PSI.B.readASCII(fle,12+i*16,4), to = PSI.B.readUint(fle, 12+i*16+8);
			if(tn=="name") {  noff=to;  break;  }
		}
		if(noff==0) return null;

		var cnt=rus(fle, noff+2);
		var offset0=noff+6, offset=noff+6;
		for(var i=0; i<cnt; i++) {
			var platformID = rus(fle, offset   );
			var eID        = rus(fle, offset+ 2);	// encoding ID
			var languageID = rus(fle, offset+ 4);
			var nameID     = rus(fle, offset+ 6);
			var length     = rus(fle, offset+ 8);
			var noffset    = rus(fle, offset+10);
			offset += 12;
			
			var s;
			var soff = offset0 + cnt*12 + noffset;
			if(eID==1 || eID==10 || eID==3) {  s="";  for(var j=1; j<length; j+=2) s += String.fromCharCode(fle[soff+j]);  }
			if(eID==0 || eID== 2) s = PSI.B.readASCII(fle, soff, length);
			if(nameID==6 && s!=null && s.slice(0,3)!="OTS") return s.replace(/\s/g, "");
		}
		return null;
	}
	PDFI.fromWin = function(sv)
	{
		var map = PDFI._win1252;  s="";
		for(var j=0; j<sv.length; j++) {
			var cc = sv[j], ci = map.indexOf(cc);
			if(ci!=-1) cc = map[ci+1];
			s+=String.fromCharCode(cc);
		}
		return s;
	}
	PDFI.fromCName = function(cn)
	{
		if(cn.length==1) return cn;
		if(cn.slice(0,3)=="uni") return String.fromCharCode(parseInt(cn.slice(3),16));
		//var gi = parseInt(cn.slice(1));  if(cn.charAt(0)=="g" && !isNaN(gi)) return String.fromCharCode(gi);
		var map = {
			"space":32,"exclam":33,"quotedbl":34,"numbersign":35,"dollar":36,"percent":37,"parenleft":40,
			"parenright":41,"asterisk":42,"plus":43,"comma":44,"hyphen":45,"period":46,"slash":47,
			"zero":48,"one":49,"two":50,"three":51,"four":52,"five":53,"six":54,"seven":55,"eight":56,"nine":57,
			"colon":58,"semicolon":59,"less":60,"equal":61,"at":64,
			"bracketleft":91,"bracketright":93,"underscore":95,"braceleft":123,"braceright":125,
			"dieresis":168,"circlecopyrt":169,"Eacute":201,
			"dotlessi":0x0131,
			"alpha":0x03B1,"phi":0x03C6,
			"endash":0x2013,"emdash":0x2014,"asteriskmath":0x2217,"quoteright":0x2019,"quotedblleft":0x201C,"quotedblright":0x201D,"bullet":0x2022,
			"minus":0x2202,
			"fi": 0xFB01,"fl":0xFB02 };
		var mc = map[cn];
		if(mc==null) {  if(cn.charAt(0)!="g") console.log("unknown character "+cn);  
			return cn;  }
		return String.fromCharCode(mc);
	}
	
	PDFI.toUnicode = function(sar, tou) {
		var cmap = tou["cmap"], s = "";
		if(cmap==null) {
			var file = {buff:tou["stream"], off:0};
			//console.log(PSI.B.readASCII(file.buff, 0, file.buff.length));
			var os = [];	// operand stack
			var ds = PSI._getDictStack({});
			var es = [{  typ:"file", val: file  }];	// execution stack
			var gs = [];
			var env = PSI._getEnv([0,0,1,1]);  env.pgOpen = true;
			var time = Date.now();
			var repeat = true;
			while(repeat) repeat = PSI.step(os, ds, es, gs, env, null, PDFI.operator);
			cmap = env.res["CMap"];
			tou["cmap"] = cmap;
			//console.log(cmap);  throw "e";
		}
		//console.log(cmap);
		//cmap = cmap["Adobe-Identity-UCS"];
		for(var p in cmap) {  cmap=cmap[p];  break;  }
		//console.log(cmap, sar);  throw "e";
		var bfr = cmap.bfrange, bfc = cmap.bfchar, bpc = cmap["bpc"];
		for(var i=0; i<sar.length; i+=bpc) {
			var cc = sar[i];  if(bpc==2) cc = (cc<<8) | sar[i+1];
			var mpd = false;
			if(!mpd && bfr) for(var j=0; j<bfr.length; j+=3) {
				var v0=bfr[j], v1=bfr[j+1], v2=bfr[j+2];
				if(v0<=cc && cc<=v1) {  
					if(v2.length==null) cc+=v2-v0;  
					else cc = v2[cc-v0];
					mpd=true;  break;  
				}
			}
			if(!mpd && bfc) for(var j=0; j<bfc.length; j+=2) if(bfc[j]==cc) {  cc=bfc[j+1];  mpd=true;  break;  }
			s += String.fromCharCode(cc);
		}
		return s;
	}
	PDFI._win1252 = [ 0x80, 0x20AC, 0x82, 0x201A, 0x83, 0x0192,	0x84, 0x201E, 0x85, 0x2026, 0x86, 0x2020, 0x87, 0x2021, 0x88, 0x02C6, 0x89, 0x2030,
0x8A, 0x0160, 0x8B, 0x2039, 0x8C, 0x0152, 0x8E, 0x017D, 0x91, 0x2018, 0x92, 0x2019, 0x93, 0x201C, 0x94, 0x201D, 0x95, 0x2022, 0x96, 0x2013,
0x97, 0x2014, 0x98, 0x02DC, 0x99, 0x2122, 0x9A, 0x0161, 0x9B, 0x203A, 0x9C, 0x0153, 0x9E, 0x017E, 0x9F, 0x0178	];
	
	PDFI.readXrefTrail = function(buff, xref, out)
	{
		var kw = PSI.B.readASCII(buff, xref, 4);
		if(kw=="xref") {
			var off = xref+4;  
			if(buff[off]==13) off++;  if(buff[off]==10) off++;
			while(true) {	// start of the line with M, N
				if(PSI.B.readASCII(buff, off, 7)=="trailer") {  off+=8;  break;  }
				var of0 = off;
				while(!PSI.isEOL(buff[off])) off++;  
				var line = PSI.B.readASCII(buff,  of0, off-of0);  //console.log(line);  
				line = line.split(" ");
				var n = parseInt(line[1]);
				if(buff[off]==13) off++;  if(buff[off]==10) off++;
				for(var i=0; i<n; i++)
				{
					var li = parseInt(line[0])+i;
					if(out[li]==null) out[li] = {
						off: parseInt(PSI.B.readASCII(buff, off, 10)),
						gen: parseInt(PSI.B.readASCII(buff, off+11, 5)),
						chr: PSI.B.readASCII(buff, off+17, 1),
						val: null,
						opn: false
					};
					off+=20;
				}
			}
			var file = {buff:buff, off:off};//, trw = PSI.getFToken(file);
			var trl = PDFI.readObject(file, file, out);
			if(trl["/Prev"]) PDFI.readXrefTrail(buff, trl["/Prev"], out);
			return trl;
		}
		else {
			var off = xref;
			while(!PSI.isEOL(buff[off])) off++;   off++;
			
			var xr = PDFI.readObject({buff:buff, off:off}, file, null);  //console.log(xr);
			var sof = 0, sb = xr["stream"], w = xr["/W"], ind = (xr["/Index"] ? xr["/Index"][0] : 0);
			while(sof<sb.length) {
				var typ=PDFI.getInt(sb,sof,w[0]);  sof+=w[0];
				var a  =PDFI.getInt(sb,sof,w[1]);  sof+=w[1];
				var b  =PDFI.getInt(sb,sof,w[2]);  sof+=w[2];
				var off=0, gen=0, chr="n";
				if(typ==0) {off=a;  gen=b;  chr="f";}
				if(typ==1) {off=a;  gen=b;  chr="n";}
				if(typ==2) {off=a;  gen=b;  chr="s";}
				out[ind] = { off: off, gen: gen, chr: chr, val: null, opn: false };  ind++;
			}
			if(xr["/Prev"]) PDFI.readXrefTrail(buff, xr["/Prev"], out);
			//*
			var fl = {buff:buff, off:0};
			var ps = ["/Root","/Info"];
			for(var i=0; i<ps.length; i++) {
				var p = ps[i], val = xr[p];
				if(val && val.typ=="ref") xr[p] = PDFI.getIndirect(val.ind, val.gen, fl, out);
			}
			//*/
			return xr;
		}
	}
	PDFI.getInt = function(b,o,l) {
		if(l==0) return 0;
		if(l==1) return b[o];
		if(l==2) return ((b[o]<< 8)|b[o+1]);
		if(l==3) return ((b[o]<<16)|(b[o+1]<<8)|b[o+2]);   throw "e";
	}
	
	PDFI.getIndirect = function(i,g,file,xr)
	{
		var xv = xr[i];
		if(xv.chr=="f") return null;
		if(xv.val!=null) return xv.val;
		if(xv.opn) return {typ:"ref",ind:i, gen:g};
		
		xv.opn = true;
		var ooff = file.off, nval;
		
		if(xv.chr=="s") {
			var os = PDFI.getIndirect(xv.off, xv.gen, file, xr), fle = {buff:os["stream"], off:0};
			var idx=0, ofs=0;
			while(idx!=i) {  idx=PSI.getFToken(fle).val;  ofs=PSI.getFToken(fle).val;  }
			fle.off = ofs+os["/First"];
			nval = PDFI.readObject(fle, file, xr);
		}
		else {
			file.off = xv.off;
			var a=PSI.getFToken(file), b=PSI.getFToken(file), c=PSI.getFToken(file);
			//console.log(a,b,c);
			nval = PDFI.readObject(file, file, xr);
		}
		
		xv.val = nval;
		file.off = ooff;  xv.opn = false;
		return nval;
	}
	
	PDFI.readObject = function(file, mfile, xr) 
	{
		//console.log(file.off, file.buff);
		var tok = PSI.getFToken(file);
		//console.log(tok);
		if(tok.typ=="integer") {
			var off = file.off;
			var tok2 = PSI.getFToken(file);
			if(tok2.typ=="integer") {
				PSI.skipWhite(file);
				if(file.buff[file.off]==82) {
					file.off++;  
					if(xr && xr[tok.val]) return PDFI.getIndirect(tok.val, tok2.val, mfile, xr);
					else   return {typ:"ref",ind:tok.val, gen:tok2.val};
				}
			}
			file.off = off;
		}
		
		if(tok.val=="<<") return PDFI.readDict(file, mfile, xr);
		if(tok.val=="[" ) return PDFI.readArra(file, mfile, xr);
		if(tok.typ=="string") {
			var s = "";  for(var i=0; i<tok.val.length; i++) s+=String.fromCharCode(tok.val[i]);
			return s;
		}
		return tok.val;
	}
	PDFI.readDict = function(file, mfile, xr) {
		var o = {};
		while(true) {
			var off=file.off, tok = PSI.getFToken(file);
			if(tok.typ=="name" && tok.val==">>") break;
			file.off= off;
			var key = PDFI.readObject(file, mfile, xr);
			var val = PDFI.readObject(file, mfile, xr);
			o[key] = val;
		}
		if(o["/Length"]!=null) {
			var l = o["/Length"];
			var tk = PSI.getFToken(file);  if(file.buff[file.off]==13) file.off++;  if(file.buff[file.off]==10) file.off++;
			
			var buff = file.buff.slice(file.off, file.off+l);  file.off += l;  PSI.getFToken(file); // endstream
			
			var flt = o["/Filter"], prm=o["/DecodeParms"];
			if(flt!=null) {
				var fla = (typeof flt == "string") ? [flt] : flt;
				var keepFlt = false;
				for(var i=0; i<fla.length; i++) {
					var cf = fla[i], fl = {buff:buff, off:0};
					if     (cf=="/FlateDecode"  ) {  buff = PSI.F.FlateDecode(fl);  }
					else if(cf=="/ASCII85Decode") {  buff = PSI.F.ASCII85Decode(fl);  }
					else if(cf=="/DCTDecode" || cf=="/CCITTFaxDecode" || cf=="/JPXDecode" || cf=="/JBIG2Decode") {  keepFlt = true;  }  // JPEG
					else {  console.log(cf, buff);  throw "e";  }
				}
				if(!keepFlt) delete o["/Filter"];
			}
			if(prm!=null) {
				if(prm instanceof Array) prm = prm[0];
				if(prm["/Predictor"]!=null && prm["/Predictor"]!=1) {
					var w = prm["/Columns"], bpp = prm["/Colors"] ? prm["/Colors"]: 1, bpl = (bpp*w), h = (buff.length/(bpl+1));
					PDFI._filterZero(buff, 0, w, h, bpp);  buff = buff.slice(0, h*bpl);
				}
			}
			o["stream"] = buff;
		}
		return o;
	}
	PDFI.readArra = function(file, mfile, xr) {
		var o = [];
		while(true) {
			var off=file.off, tok = PSI.getFToken(file);
			if(tok.typ=="name" && tok.val=="]") return o;
			file.off = off;
			var val = PDFI.readObject(file, mfile, xr);
			o.push(val);
		}
	}
	
	PDFI._filterZero = function(data, off, w, h, bpp) {  // copied from UPNG.js
		var bpl = bpp*w, paeth = PDFI._paeth;

		for(var y=0; y<h; y++)  {
			var i = off+y*bpl, di = i+y+1;
			var type = data[di-1];

			if     (type==0) for(var x=  0; x<bpl; x++) data[i+x] = data[di+x];
			else if(type==1) {
				for(var x=  0; x<bpp; x++) data[i+x] = data[di+x];
				for(var x=bpp; x<bpl; x++) data[i+x] = (data[di+x] + data[i+x-bpp])&255;
			}
			else if(y==0) {
				for(var x=  0; x<bpp; x++) data[i+x] = data[di+x];
				if(type==2) for(var x=bpp; x<bpl; x++) data[i+x] = (data[di+x])&255;
				if(type==3) for(var x=bpp; x<bpl; x++) data[i+x] = (data[di+x] + (data[i+x-bpp]>>1) )&255;
				if(type==4) for(var x=bpp; x<bpl; x++) data[i+x] = (data[di+x] + paeth(data[i+x-bpp], 0, 0) )&255;
			}
			else {
				if(type==2) { for(var x=  0; x<bpl; x++) data[i+x] = (data[di+x] + data[i+x-bpl])&255;  }

				if(type==3) { for(var x=  0; x<bpp; x++) data[i+x] = (data[di+x] + (data[i+x-bpl]>>1))&255;
							  for(var x=bpp; x<bpl; x++) data[i+x] = (data[di+x] + ((data[i+x-bpl]+data[i+x-bpp])>>1) )&255;  }

				if(type==4) { for(var x=  0; x<bpp; x++) data[i+x] = (data[di+x] + paeth(0, data[i+x-bpl], 0))&255;
							  for(var x=bpp; x<bpl; x++) data[i+x] = (data[di+x] + paeth(data[i+x-bpp], data[i+x-bpl], data[i+x-bpp-bpl]) )&255;  }
			}
		}
		return data;
	}
	
	PDFI._paeth = function(a,b,c) {
		var p = a+b-c, pa = Math.abs(p-a), pb = Math.abs(p-b), pc = Math.abs(p-c);
		if (pa <= pb && pa <= pc)  return a;
		else if (pb <= pc)  return b;
		return c;
	}
	

	function ToPDF()
	{
		this._res = {  
			"/Font": {},
			"/XObject":{},
			"/ExtGState":{},
			"/Pattern":{}
		};
		this._xr = [
			null, 
			{ "/Type":"/Catalog", "/Pages":{typ:"ref",ind:2}},
			{ "/Type":"/Pages",   "/Kids" :[  ], "/Count":0 },
			this._res
		];
		this._bnds = [];
		this._cont = "";
		this._gst = ToPDF.defState();
	}
	
	ToPDF.defState = function() {
		return {"colr":"[0,0,0]", "COLR":"[0,0,0]", "lcap":"0","ljoin":"0", "lwidth":"1", "mlimit":"10", "dash":"[]","doff":"0", "bmode":"/Normal","CA":"1","ca":"1"}
	}
	
	ToPDF.prototype.StartPage = function(x0,y0,x1,y1) {  this._bnds = [x0,y0,x1,y1] ; }
	
	ToPDF.prototype.Stroke = function(gst) {
		if(gst.CA==0) return;
		this.setGState(gst, true);
		this._cont += " S\n";
	}
	ToPDF.prototype.Fill = function(gst, evenOdd)
	{
		if(gst.ca==0) return;
		this.setGState(gst, true);
		this._cont += " f\n";
	}
	
	ToPDF._flt   = function(n)  {  return ""+parseFloat(n.toFixed(2));  }
	ToPDF._scale = function(m)  {  return Math.sqrt(Math.abs(m[0]*m[3]-m[1]*m[2]));  };
	ToPDF._mat   = function(m){  var ms = m.map(ToPDF._flt).join(" ");  
		if(ms=="1 0 0 1 0 0") return "";  return ms+" cm ";  }
	ToPDF._eq    = function(a,b){  if(a.length!=b.length) return false;
		for(var i=0; i<a.length; i++) if(a[i]!=b[i]) return false;
		return true;
	}
	ToPDF._format = function(b) {
		var pfx = [ [0xff, 0xd8, 0xff      ], // "jpg";	
		[0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20], // JPX	
		[0x00, 0x00, 0x00, 0x00, 0x30, 0x00, 0x01, 0x00] ] // JBIG2
		var fmt = ["/DCTDecode", "/JPXDecode", "/JBIG2Decode"];
		for(var i=0; i<pfx.length; i++){
			var pf = pfx[i], good = true;
			for(var j=0; j<pf.length; j++) good = good && (b[j]==pf[j]);
			if(good) return fmt[i];
		}
	}
	
	ToPDF.prototype.setGState = function(gst, withPath) {
		var ost = this._gst, nst = {};
		for(var p in gst)  nst[p] = (typeof gst[p]=="string") ? gst[p] : JSON.stringify(gst[p]);
		var scl = ToPDF._scale(gst.ctm);
		var dsh = gst.dash.slice(0);  for(var i=0; i<dsh.length; i++) dsh[i] = ToPDF._flt(dsh[i]*scl);
		
		var cnt = this._cont;
		if(ost.lcap !=nst.lcap   ) cnt += gst.lcap + " J ";
		if(ost.ljoin!=nst.ljoin  ) cnt += gst.ljoin + " j ";
		if(ost.lwidth!=nst.lwidth) cnt += ToPDF._flt(gst.lwidth*scl) + " w ";
		if(ost.mlimit!=nst.mlimit) cnt += ToPDF._flt(gst.mlimit) + " M ";
		if(ost.dash!=nst.dash || ost.doff!=nst.doff) cnt += "["+dsh.join(" ")+"] "+gst.doff+" d ";
		if(ost.COLR !=nst.COLR   ) cnt += gst.COLR.map(ToPDF._flt).join(" ") + " RG ";
		if(ost.colr !=nst.colr   ) {
			if(gst.colr.length!=null) cnt += gst.colr .map(ToPDF._flt).join(" ") + " rg \n";
			else {
				var ps = this._res["/Pattern"], grd = gst.colr;
				var pi = "/P"+(ToPDF.maxI(ps)+1);
				var sh = {
					"/ShadingType":(grd.typ=="lin"?2:3),
					"/ColorSpace":"/DeviceRGB",
					"/Extend":[true, true],
					"/Function" : ToPDF._makeGrad(grd.grad),
					"/Coords" : grd.crds
				};
				ps[pi] = {
					"/Type":"/Pattern",
					"/PatternType":2,
					"/Matrix":grd.mat,
					"/Shading":sh
				}
				cnt += "/Pattern cs "+pi+" scn ";
			}
		}
		var eg = this._res["/ExtGState"];
		if(ost.bmode!=nst.bmode  ) {
			var sname = nst.bmode;
			if(eg[sname]==null) eg[sname] = {"/Type":"/ExtGState", "/BM":gst.bmode};
			cnt += sname + " gs ";
		}
		if(ost.CA!=nst.CA) {
			var sname = "/Alpha"+Math.round(255*nst.CA);
			if(eg[sname]==null) eg[sname] = {"/Type":"/ExtGState", "/CA":gst.CA};
			cnt += sname + " gs ";
		}
		if(ost.ca!=nst.ca) {
			var sname = "/alpha"+Math.round(255*nst.ca);
			if(eg[sname]==null) eg[sname] = {"/Type":"/ExtGState", "/ca":gst.ca};
			cnt += sname + " gs ";
		}
		/*if(ost.pth  !=nst.pth    )*/ 
		if(withPath) cnt += ToPDF.drawPath(gst.pth);
		
		//console.log(ost, nst);
		
		this._cont = cnt;
		this._gst = nst;
	}
	ToPDF.drawPath = function(pth) {
		var co = 0, out = "", F = ToPDF._flt;
		for(var i=0; i<pth.cmds.length; i++) {
			var cmd = pth.cmds[i];
			if     (cmd=="M") {  for(var j=0; j<2; j++) out += F(pth.crds[co++]) + " ";  out += "m ";  }
			else if(cmd=="L") {  for(var j=0; j<2; j++) out += F(pth.crds[co++]) + " ";  out += "l ";  }
			else if(cmd=="C") {  for(var j=0; j<6; j++) out += F(pth.crds[co++]) + " ";  out += "c ";  }
			else if(cmd=="Z") {  out += "h ";  }
			else throw cmd;
		}
		return out;
	}
	ToPDF._makeGrad = function(grd) {
		//grd = grd.slice(0);  grd[1]=grd[2];  grd = grd.slice(0,2);
		var bs = [], fs = [], sf = ToPDF._stopFun;
		if(grd.length==2) return sf(grd[0][1], grd[1][1]);
		fs.push(sf(grd[0][1], grd[1][1]));
		for(var i=1; i<grd.length-1; i++) {  bs.push(grd[i][0]);  fs.push(sf(grd[i][1], grd[i+1][1]));  }
		
		return {
			"/FunctionType":3,"/Encode":[0,1,0,1],"/Domain":[0,1],
			"/Bounds":bs, "/Functions":fs
		}
	}
	ToPDF._stopFun = function(c0, c1) {  return { "/FunctionType":2, "/C0":c0, "/C1":c1, "/Domain":[0,1], "/N":1};  }
	
	ToPDF.prototype.PutText = function(gst,str, stw)
	{		
		this.setGState(gst, false);
		var fi = this.addFont(gst.font.Tf);
		this._cont += "q ";
		this._cont += ToPDF._mat(gst.ctm);  
		this._cont += ToPDF._mat(gst.font.Tm);
		this._cont += "BT  "+fi+" "+ToPDF._flt(gst.font.Tfs)+" Tf  0 0 Td  ("
		
		var win = [ 0x80, 0x20AC, 0x82, 0x201A, 0x83, 0x0192,	0x84, 0x201E, 0x85, 0x2026, 0x86, 0x2020, 0x87, 0x2021, 0x88, 0x02C6, 0x89, 0x2030,
0x8A, 0x0160, 0x8B, 0x2039, 0x8C, 0x0152, 0x8E, 0x017D, 0x91, 0x2018, 0x92, 0x2019, 0x93, 0x201C, 0x94, 0x201D, 0x95, 0x2022, 0x96, 0x2013,
0x97, 0x2014, 0x98, 0x02DC, 0x99, 0x2122, 0x9A, 0x0161, 0x9B, 0x203A, 0x9C, 0x0153, 0x9E, 0x017E, 0x9F, 0x0178	];
		var bys = [];
		for(var i=0; i<str.length; i++) {  
			var cc=str.charCodeAt(i);  
			if(cc>255) {  
				var bi = win.indexOf(cc);
				bys.push(bi==-1 ? 32 : win[bi-1]);  
			}
			else bys.push(cc);
		}
		
		bys = PSI.makeString(bys);
		
		for(var i=0; i<bys.length; i++) this._cont += String.fromCharCode(bys[i]);
		
		this._cont += ") Tj  ET ";
		this._cont += " Q\n";
	}
	
	ToPDF.prototype.PutImage = function(gst, img, w, h, msk) {
	
		if(img.length==w*h*4 && msk==null) {
			var area = w*h;
			var alph = new Uint8Array(area), aand = 255;
			for(var i=0; i<area; i++) {  alph[i] = img[(i<<2)+3];  aand &= img[(i<<2)+3];  }
			if(aand!=255) msk = alph;
		}
		
		var ii = this.addImage(img,w,h, msk);
		this.setGState(gst, false);
		
		this._cont += "q "+ToPDF._mat(gst.ctm);
		this._cont += ii + " Do  Q\n";
	}
	
	ToPDF.prototype.ShowPage = function() {
		//console.log(this._cont);
		//console.log(this._res);
		ToPDF.addPage(this._xr, this._cont, this._bnds);
		this._cont = "";
		this._gst = ToPDF.defState();
	}
	
	ToPDF.prototype.Print = function(str) {
	}
	
	ToPDF.prototype.Done = function() {
		var res = this._res;
		for(var p in res) if(Object.keys(res[p])==0) delete res[p];
		this.buffer = ToPDF.xrToPDF(this._xr);
	}
	ToPDF.prototype.addImage= function(img, w, h, msk){
		//console.log(img.length, w*h);
		var mii;
		if(msk) {
			var mst = msk;
			if(msk.length==w*h*4) {
				mst = new Uint8Array(w*h);
				for(var i=0; i<mst.length; i++) mst[i] = msk[(i<<2)+1];
			}
			mii = this.addImage(mst, w, h, null);
		}
		
		var fmt = ToPDF._format(img);
		
		var ist = img;
		if(img.length==w*h*4) {
			ist = new Uint8Array(w*h*3);
			for(var i=0; i<img.length; i+=4) {  var ti = 3*(i>>2);  ist[ti]=img[i+0];  ist[ti+1]=img[i+1];  ist[ti+2]=img[i+2];    }
		}
		
		var xo = this._res["/XObject"];
		for(var ii in xo) if(ToPDF._eq(this._xr[xo[ii].ind]["stream"],ist)) return ii;
		var ii = "/I"+(ToPDF.maxI(xo)+1);
		xo[ii] = {"typ":"ref",ind:this._xr.length};
		
		var io = {
			"/Type":"/XObject",
			"/Subtype":"/Image",
			"/BitsPerComponent":8,
			"/ColorSpace":(img.length==w*h || (fmt=="/DCTDecode" && ToPDF.jpgProp(img).comps==1)) ? "/DeviceGray" : "/DeviceRGB",
			"/Height":h,
			"/Width":w,
			"stream":ist
		}
		if(fmt!=null) io["/Filter"] = ToPDF._format(img);
		if(msk) {  io["/SMask"] = {"typ":"ref","ind":this._xr.length-1};  delete xo[mii];  }
		this._xr.push(io);
		return ii;
	}
	ToPDF.jpgProp = function(data) {
		var off = 0;
		while(off<data.length) {
			while(data[off]==0xff) off++;
			var mrkr = data[off];  off++;
			
			if(mrkr==0xd8) continue;	// SOI
			if(mrkr==0xd9) break;		// EOI
			if(0xd0<=mrkr && mrkr<=0xd7) continue;
			if(mrkr==0x01) continue;	// TEM
			
			var len = ((data[off]<<8)|data[off+1])-2;  off+=2;  
			
			if(mrkr==0xc0) return {
				bpp : data[off],
				w : (data[off+1]<<8)|data[off+2],
				h : (data[off+3]<<8)|data[off+4],
				comps : data[off+5]
			}
			off+=len;
		}
	}
	ToPDF.readUshort = function(data, o) {  return ((data[o]<<8)|data[o+1]);  }
	ToPDF.maxI = function(xo) {
		var max;
		for(var ii in xo) max = ii;
		return max==null ? 0 : parseInt(max.slice(2));
	}
	ToPDF.prototype.addFont = function(fn) {
		var fs = this._res["/Font"];
		for(var fi in fs) if(fs[fi]["/BaseFont"].slice(1)==fn) return fi;
		var fi = "/F"+(ToPDF.maxI(fs)+1);
		fs[fi] = {  "/Type":"/Font",  "/Subtype":"/Type1",  "/BaseFont": "/"+fn, "/Encoding":"/WinAnsiEncoding"  // Type1 supports only 1 Byte per character, otherwise use Type0 
			////"/Encoding":"/Identity-H",  "/DescendantFonts":[{  "/BaseFont":"/"+fn,  "/CIDToGIDMap":"/Identity"  }], "/ToUnicode":{"typ":"ref",ind:4} 
		};
		return fi;
	}
	ToPDF.addPage = function(xr, stm, box) {
		var i = xr.length;
		xr[2]["/Kids"].push({typ:"ref",ind:i});
		xr[2]["/Count"]++;
		xr.push({ "/Type":"/Page",    
			"/Parent"   :{ typ:"ref",ind:2 }, 
			"/Resources":{ typ:"ref",ind:3 },
			"/MediaBox": box,
			"/Contents" :{ typ:"ref",ind:i+1 }
		});
		xr.push({"stream":stm});
	}
	
	ToPDF.xrToPDF = function(xr)
	{
		var F = {file:new ToPDF.MFile(), off:0}, W = ToPDF.write, offs = [];
		
		W(F, "%PDF-1.1\n");
		for(var i=1; i<xr.length; i++) {
			offs.push(F.off);
			W(F, i+" 0 obj\n");
			ToPDF.writeDict(F, xr[i], 0);
			W(F, "\nendobj\n");
		}
		var sxr = F.off;
		W(F, "xref\n");
		W(F, "0 "+xr.length+"\n");
		W(F, "0000000000 65535 f \n");
		for(var i=0; i<offs.length; i++) {
			var oo = offs[i]+"";  while(oo.length<10) oo = "0"+oo;
			W(F, oo+" 00000 n \n");
		}
		W(F, "trailer\n");
		ToPDF.writeDict(F, {"/Root": {typ:"ref", ind:1}, "/Size":xr.length}, 0);
		W(F, "\nstartxref\n"+sxr+"\n%%EOF\n");
		return F.file.data.buffer.slice(0, F.off);
	}
	ToPDF.write = function(F, s)
	{
		F.file.req(F.off, s.length);
		for(var i=0; i<s.length; i++) F.file.data[F.off+i] = s.charCodeAt(i);
		F.off+=s.length;
	}
	ToPDF._tab = "    ";
	ToPDF.spc = function(n) {  var out="";  for(var i=0; i<n; i++) out+=ToPDF._tab;  return out;  }
	ToPDF.writeValue = function(F, v, dpt)
	{
		var W = ToPDF.write;
		if(false) {}
		else if(typeof v == "string" ) W(F, v);
		else if(typeof v == "number" ) W(F, ""+v);
		else if(typeof v == "boolean") W(F, ""+v);
		else if(v.typ!=null) W(F, v.ind+" 0 R");
		else if(v instanceof Array ) ToPDF.writeArray(F, v, dpt+1);
		else if(v instanceof Object) ToPDF.writeDict (F, v, dpt+1);
		else {  console.log(v);  throw "e";  }
	}
	ToPDF.writeDict = function(F, d, dpt) {
		var W = ToPDF.write, S = ToPDF.spc;
		var stm = d["stream"];
		if(stm) {
			if((typeof stm)=="string") {
				var nstm = new Uint8Array(stm.length);
				for(var i=0; i<stm.length; i++) nstm[i]=stm.charCodeAt(i);
				stm = nstm;  
			}
			if(d["/Filter"]==null) {
				d["/Filter"]="/FlateDecode";
				stm = pako["deflate"](stm);
			}
		}
		W(F,"<<\n");
		for(var p in d) {
			if(p.charAt(0)!="/") continue;
			W(F, S(dpt+1)+p+" "); 
			ToPDF.writeValue(F, d[p], dpt);
			W(F, "\n");
		}
		if(stm) W(F, S(dpt+1)+"/Length "+stm.length+"\n");
		W(F,S(dpt)+">>");
		if(stm) {
			W(F, S(dpt)+"\nstream\n");
			F.file.req(F.off, stm.length);
			for(var i=0; i<stm.length; i++) F.file.data[F.off+i]=stm[i];
			F.off += stm.length;
			W(F, S(dpt)+"\nendstream");
		}
	}
	ToPDF.writeArray = function(F, a, dpt)
	{
		var W = ToPDF.write;
		W(F,"[ ");
		for(var i=0; i<a.length; i++) {
			ToPDF.writeValue(F, a[i], dpt+1);
			if(i!=a.length-1) W(F, " ");
		}
		W(F," ]");
	}
	
	ToPDF.MFile = function()
	{
		this.size = 16;
		this.data = new Uint8Array(16);
	}
	ToPDF.MFile.prototype.req = function(off, len)
	{
		if(off + len <= this.size) return;
		var ps = this.size;
		while(off+len>this.size) this.size *= 2;
		var ndata = new Uint8Array(this.size);
		for(var i=0; i<ps; i++) ndata[i] = this.data[i];
		this.data = ndata;
	}
	
	/* pako 1.0.5 nodeca/pako */
!function(t){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=t();else if("function"==typeof define&&define.amd)define([],t);else{var e;e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof self?self:this,e.pako=t()}}(function(){return function t(e,a,i){function n(s,o){if(!a[s]){if(!e[s]){var l="function"==typeof require&&require;if(!o&&l)return l(s,!0);if(r)return r(s,!0);var h=new Error("Cannot find module '"+s+"'");throw h.code="MODULE_NOT_FOUND",h}var d=a[s]={exports:{}};e[s][0].call(d.exports,function(t){var a=e[s][1][t];return n(a?a:t)},d,d.exports,t,e,a,i)}return a[s].exports}for(var r="function"==typeof require&&require,s=0;s<i.length;s++)n(i[s]);return n}({1:[function(t,e,a){"use strict";function i(t){if(!(this instanceof i))return new i(t);this.options=l.assign({level:w,method:v,chunkSize:16384,windowBits:15,memLevel:8,strategy:p,to:""},t||{});var e=this.options;e.raw&&e.windowBits>0?e.windowBits=-e.windowBits:e.gzip&&e.windowBits>0&&e.windowBits<16&&(e.windowBits+=16),this.err=0,this.msg="",this.ended=!1,this.chunks=[],this.strm=new f,this.strm.avail_out=0;var a=o.deflateInit2(this.strm,e.level,e.method,e.windowBits,e.memLevel,e.strategy);if(a!==b)throw new Error(d[a]);if(e.header&&o.deflateSetHeader(this.strm,e.header),e.dictionary){var n;if(n="string"==typeof e.dictionary?h.string2buf(e.dictionary):"[object ArrayBuffer]"===_.call(e.dictionary)?new Uint8Array(e.dictionary):e.dictionary,a=o.deflateSetDictionary(this.strm,n),a!==b)throw new Error(d[a]);this._dict_set=!0}}function n(t,e){var a=new i(e);if(a.push(t,!0),a.err)throw a.msg||d[a.err];return a.result}function r(t,e){return e=e||{},e.raw=!0,n(t,e)}function s(t,e){return e=e||{},e.gzip=!0,n(t,e)}var o=t("./zlib/deflate"),l=t("./utils/common"),h=t("./utils/strings"),d=t("./zlib/messages"),f=t("./zlib/zstream"),_=Object.prototype.toString,u=0,c=4,b=0,g=1,m=2,w=-1,p=0,v=8;i.prototype.push=function(t,e){var a,i,n=this.strm,r=this.options.chunkSize;if(this.ended)return!1;i=e===~~e?e:e===!0?c:u,"string"==typeof t?n.input=h.string2buf(t):"[object ArrayBuffer]"===_.call(t)?n.input=new Uint8Array(t):n.input=t,n.next_in=0,n.avail_in=n.input.length;do{if(0===n.avail_out&&(n.output=new l.Buf8(r),n.next_out=0,n.avail_out=r),a=o.deflate(n,i),a!==g&&a!==b)return this.onEnd(a),this.ended=!0,!1;0!==n.avail_out&&(0!==n.avail_in||i!==c&&i!==m)||("string"===this.options.to?this.onData(h.buf2binstring(l.shrinkBuf(n.output,n.next_out))):this.onData(l.shrinkBuf(n.output,n.next_out)))}while((n.avail_in>0||0===n.avail_out)&&a!==g);return i===c?(a=o.deflateEnd(this.strm),this.onEnd(a),this.ended=!0,a===b):i!==m||(this.onEnd(b),n.avail_out=0,!0)},i.prototype.onData=function(t){this.chunks.push(t)},i.prototype.onEnd=function(t){t===b&&("string"===this.options.to?this.result=this.chunks.join(""):this.result=l.flattenChunks(this.chunks)),this.chunks=[],this.err=t,this.msg=this.strm.msg},a.Deflate=i,a.deflate=n,a.deflateRaw=r,a.gzip=s},{"./utils/common":3,"./utils/strings":4,"./zlib/deflate":8,"./zlib/messages":13,"./zlib/zstream":15}],2:[function(t,e,a){"use strict";function i(t){if(!(this instanceof i))return new i(t);this.options=o.assign({chunkSize:16384,windowBits:0,to:""},t||{});var e=this.options;e.raw&&e.windowBits>=0&&e.windowBits<16&&(e.windowBits=-e.windowBits,0===e.windowBits&&(e.windowBits=-15)),!(e.windowBits>=0&&e.windowBits<16)||t&&t.windowBits||(e.windowBits+=32),e.windowBits>15&&e.windowBits<48&&0===(15&e.windowBits)&&(e.windowBits|=15),this.err=0,this.msg="",this.ended=!1,this.chunks=[],this.strm=new f,this.strm.avail_out=0;var a=s.inflateInit2(this.strm,e.windowBits);if(a!==h.Z_OK)throw new Error(d[a]);this.header=new _,s.inflateGetHeader(this.strm,this.header)}function n(t,e){var a=new i(e);if(a.push(t,!0),a.err)throw a.msg||d[a.err];return a.result}function r(t,e){return e=e||{},e.raw=!0,n(t,e)}var s=t("./zlib/inflate"),o=t("./utils/common"),l=t("./utils/strings"),h=t("./zlib/constants"),d=t("./zlib/messages"),f=t("./zlib/zstream"),_=t("./zlib/gzheader"),u=Object.prototype.toString;i.prototype.push=function(t,e){var a,i,n,r,d,f,_=this.strm,c=this.options.chunkSize,b=this.options.dictionary,g=!1;if(this.ended)return!1;i=e===~~e?e:e===!0?h.Z_FINISH:h.Z_NO_FLUSH,"string"==typeof t?_.input=l.binstring2buf(t):"[object ArrayBuffer]"===u.call(t)?_.input=new Uint8Array(t):_.input=t,_.next_in=0,_.avail_in=_.input.length;do{if(0===_.avail_out&&(_.output=new o.Buf8(c),_.next_out=0,_.avail_out=c),a=s.inflate(_,h.Z_NO_FLUSH),a===h.Z_NEED_DICT&&b&&(f="string"==typeof b?l.string2buf(b):"[object ArrayBuffer]"===u.call(b)?new Uint8Array(b):b,a=s.inflateSetDictionary(this.strm,f)),a===h.Z_BUF_ERROR&&g===!0&&(a=h.Z_OK,g=!1),a!==h.Z_STREAM_END&&a!==h.Z_OK)return this.onEnd(a),this.ended=!0,!1;_.next_out&&(0!==_.avail_out&&a!==h.Z_STREAM_END&&(0!==_.avail_in||i!==h.Z_FINISH&&i!==h.Z_SYNC_FLUSH)||("string"===this.options.to?(n=l.utf8border(_.output,_.next_out),r=_.next_out-n,d=l.buf2string(_.output,n),_.next_out=r,_.avail_out=c-r,r&&o.arraySet(_.output,_.output,n,r,0),this.onData(d)):this.onData(o.shrinkBuf(_.output,_.next_out)))),0===_.avail_in&&0===_.avail_out&&(g=!0)}while((_.avail_in>0||0===_.avail_out)&&a!==h.Z_STREAM_END);return a===h.Z_STREAM_END&&(i=h.Z_FINISH),i===h.Z_FINISH?(a=s.inflateEnd(this.strm),this.onEnd(a),this.ended=!0,a===h.Z_OK):i!==h.Z_SYNC_FLUSH||(this.onEnd(h.Z_OK),_.avail_out=0,!0)},i.prototype.onData=function(t){this.chunks.push(t)},i.prototype.onEnd=function(t){t===h.Z_OK&&("string"===this.options.to?this.result=this.chunks.join(""):this.result=o.flattenChunks(this.chunks)),this.chunks=[],this.err=t,this.msg=this.strm.msg},a.Inflate=i,a.inflate=n,a.inflateRaw=r,a.ungzip=n},{"./utils/common":3,"./utils/strings":4,"./zlib/constants":6,"./zlib/gzheader":9,"./zlib/inflate":11,"./zlib/messages":13,"./zlib/zstream":15}],3:[function(t,e,a){"use strict";var i="undefined"!=typeof Uint8Array&&"undefined"!=typeof Uint16Array&&"undefined"!=typeof Int32Array;a.assign=function(t){for(var e=Array.prototype.slice.call(arguments,1);e.length;){var a=e.shift();if(a){if("object"!=typeof a)throw new TypeError(a+"must be non-object");for(var i in a)a.hasOwnProperty(i)&&(t[i]=a[i])}}return t},a.shrinkBuf=function(t,e){return t.length===e?t:t.subarray?t.subarray(0,e):(t.length=e,t)};var n={arraySet:function(t,e,a,i,n){if(e.subarray&&t.subarray)return void t.set(e.subarray(a,a+i),n);for(var r=0;r<i;r++)t[n+r]=e[a+r]},flattenChunks:function(t){var e,a,i,n,r,s;for(i=0,e=0,a=t.length;e<a;e++)i+=t[e].length;for(s=new Uint8Array(i),n=0,e=0,a=t.length;e<a;e++)r=t[e],s.set(r,n),n+=r.length;return s}},r={arraySet:function(t,e,a,i,n){for(var r=0;r<i;r++)t[n+r]=e[a+r]},flattenChunks:function(t){return[].concat.apply([],t)}};a.setTyped=function(t){t?(a.Buf8=Uint8Array,a.Buf16=Uint16Array,a.Buf32=Int32Array,a.assign(a,n)):(a.Buf8=Array,a.Buf16=Array,a.Buf32=Array,a.assign(a,r))},a.setTyped(i)},{}],4:[function(t,e,a){"use strict";function i(t,e){if(e<65537&&(t.subarray&&s||!t.subarray&&r))return String.fromCharCode.apply(null,n.shrinkBuf(t,e));for(var a="",i=0;i<e;i++)a+=String.fromCharCode(t[i]);return a}var n=t("./common"),r=!0,s=!0;try{String.fromCharCode.apply(null,[0])}catch(t){r=!1}try{String.fromCharCode.apply(null,new Uint8Array(1))}catch(t){s=!1}for(var o=new n.Buf8(256),l=0;l<256;l++)o[l]=l>=252?6:l>=248?5:l>=240?4:l>=224?3:l>=192?2:1;o[254]=o[254]=1,a.string2buf=function(t){var e,a,i,r,s,o=t.length,l=0;for(r=0;r<o;r++)a=t.charCodeAt(r),55296===(64512&a)&&r+1<o&&(i=t.charCodeAt(r+1),56320===(64512&i)&&(a=65536+(a-55296<<10)+(i-56320),r++)),l+=a<128?1:a<2048?2:a<65536?3:4;for(e=new n.Buf8(l),s=0,r=0;s<l;r++)a=t.charCodeAt(r),55296===(64512&a)&&r+1<o&&(i=t.charCodeAt(r+1),56320===(64512&i)&&(a=65536+(a-55296<<10)+(i-56320),r++)),a<128?e[s++]=a:a<2048?(e[s++]=192|a>>>6,e[s++]=128|63&a):a<65536?(e[s++]=224|a>>>12,e[s++]=128|a>>>6&63,e[s++]=128|63&a):(e[s++]=240|a>>>18,e[s++]=128|a>>>12&63,e[s++]=128|a>>>6&63,e[s++]=128|63&a);return e},a.buf2binstring=function(t){return i(t,t.length)},a.binstring2buf=function(t){for(var e=new n.Buf8(t.length),a=0,i=e.length;a<i;a++)e[a]=t.charCodeAt(a);return e},a.buf2string=function(t,e){var a,n,r,s,l=e||t.length,h=new Array(2*l);for(n=0,a=0;a<l;)if(r=t[a++],r<128)h[n++]=r;else if(s=o[r],s>4)h[n++]=65533,a+=s-1;else{for(r&=2===s?31:3===s?15:7;s>1&&a<l;)r=r<<6|63&t[a++],s--;s>1?h[n++]=65533:r<65536?h[n++]=r:(r-=65536,h[n++]=55296|r>>10&1023,h[n++]=56320|1023&r)}return i(h,n)},a.utf8border=function(t,e){var a;for(e=e||t.length,e>t.length&&(e=t.length),a=e-1;a>=0&&128===(192&t[a]);)a--;return a<0?e:0===a?e:a+o[t[a]]>e?a:e}},{"./common":3}],5:[function(t,e,a){"use strict";function i(t,e,a,i){for(var n=65535&t|0,r=t>>>16&65535|0,s=0;0!==a;){s=a>2e3?2e3:a,a-=s;do n=n+e[i++]|0,r=r+n|0;while(--s);n%=65521,r%=65521}return n|r<<16|0}e.exports=i},{}],6:[function(t,e,a){"use strict";e.exports={Z_NO_FLUSH:0,Z_PARTIAL_FLUSH:1,Z_SYNC_FLUSH:2,Z_FULL_FLUSH:3,Z_FINISH:4,Z_BLOCK:5,Z_TREES:6,Z_OK:0,Z_STREAM_END:1,Z_NEED_DICT:2,Z_ERRNO:-1,Z_STREAM_ERROR:-2,Z_DATA_ERROR:-3,Z_BUF_ERROR:-5,Z_NO_COMPRESSION:0,Z_BEST_SPEED:1,Z_BEST_COMPRESSION:9,Z_DEFAULT_COMPRESSION:-1,Z_FILTERED:1,Z_HUFFMAN_ONLY:2,Z_RLE:3,Z_FIXED:4,Z_DEFAULT_STRATEGY:0,Z_BINARY:0,Z_TEXT:1,Z_UNKNOWN:2,Z_DEFLATED:8}},{}],7:[function(t,e,a){"use strict";function i(){for(var t,e=[],a=0;a<256;a++){t=a;for(var i=0;i<8;i++)t=1&t?3988292384^t>>>1:t>>>1;e[a]=t}return e}function n(t,e,a,i){var n=r,s=i+a;t^=-1;for(var o=i;o<s;o++)t=t>>>8^n[255&(t^e[o])];return t^-1}var r=i();e.exports=n},{}],8:[function(t,e,a){"use strict";function i(t,e){return t.msg=D[e],e}function n(t){return(t<<1)-(t>4?9:0)}function r(t){for(var e=t.length;--e>=0;)t[e]=0}function s(t){var e=t.state,a=e.pending;a>t.avail_out&&(a=t.avail_out),0!==a&&(R.arraySet(t.output,e.pending_buf,e.pending_out,a,t.next_out),t.next_out+=a,e.pending_out+=a,t.total_out+=a,t.avail_out-=a,e.pending-=a,0===e.pending&&(e.pending_out=0))}function o(t,e){C._tr_flush_block(t,t.block_start>=0?t.block_start:-1,t.strstart-t.block_start,e),t.block_start=t.strstart,s(t.strm)}function l(t,e){t.pending_buf[t.pending++]=e}function h(t,e){t.pending_buf[t.pending++]=e>>>8&255,t.pending_buf[t.pending++]=255&e}function d(t,e,a,i){var n=t.avail_in;return n>i&&(n=i),0===n?0:(t.avail_in-=n,R.arraySet(e,t.input,t.next_in,n,a),1===t.state.wrap?t.adler=N(t.adler,e,n,a):2===t.state.wrap&&(t.adler=O(t.adler,e,n,a)),t.next_in+=n,t.total_in+=n,n)}function f(t,e){var a,i,n=t.max_chain_length,r=t.strstart,s=t.prev_length,o=t.nice_match,l=t.strstart>t.w_size-ft?t.strstart-(t.w_size-ft):0,h=t.window,d=t.w_mask,f=t.prev,_=t.strstart+dt,u=h[r+s-1],c=h[r+s];t.prev_length>=t.good_match&&(n>>=2),o>t.lookahead&&(o=t.lookahead);do if(a=e,h[a+s]===c&&h[a+s-1]===u&&h[a]===h[r]&&h[++a]===h[r+1]){r+=2,a++;do;while(h[++r]===h[++a]&&h[++r]===h[++a]&&h[++r]===h[++a]&&h[++r]===h[++a]&&h[++r]===h[++a]&&h[++r]===h[++a]&&h[++r]===h[++a]&&h[++r]===h[++a]&&r<_);if(i=dt-(_-r),r=_-dt,i>s){if(t.match_start=e,s=i,i>=o)break;u=h[r+s-1],c=h[r+s]}}while((e=f[e&d])>l&&0!==--n);return s<=t.lookahead?s:t.lookahead}function _(t){var e,a,i,n,r,s=t.w_size;do{if(n=t.window_size-t.lookahead-t.strstart,t.strstart>=s+(s-ft)){R.arraySet(t.window,t.window,s,s,0),t.match_start-=s,t.strstart-=s,t.block_start-=s,a=t.hash_size,e=a;do i=t.head[--e],t.head[e]=i>=s?i-s:0;while(--a);a=s,e=a;do i=t.prev[--e],t.prev[e]=i>=s?i-s:0;while(--a);n+=s}if(0===t.strm.avail_in)break;if(a=d(t.strm,t.window,t.strstart+t.lookahead,n),t.lookahead+=a,t.lookahead+t.insert>=ht)for(r=t.strstart-t.insert,t.ins_h=t.window[r],t.ins_h=(t.ins_h<<t.hash_shift^t.window[r+1])&t.hash_mask;t.insert&&(t.ins_h=(t.ins_h<<t.hash_shift^t.window[r+ht-1])&t.hash_mask,t.prev[r&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=r,r++,t.insert--,!(t.lookahead+t.insert<ht)););}while(t.lookahead<ft&&0!==t.strm.avail_in)}function u(t,e){var a=65535;for(a>t.pending_buf_size-5&&(a=t.pending_buf_size-5);;){if(t.lookahead<=1){if(_(t),0===t.lookahead&&e===I)return vt;if(0===t.lookahead)break}t.strstart+=t.lookahead,t.lookahead=0;var i=t.block_start+a;if((0===t.strstart||t.strstart>=i)&&(t.lookahead=t.strstart-i,t.strstart=i,o(t,!1),0===t.strm.avail_out))return vt;if(t.strstart-t.block_start>=t.w_size-ft&&(o(t,!1),0===t.strm.avail_out))return vt}return t.insert=0,e===F?(o(t,!0),0===t.strm.avail_out?yt:xt):t.strstart>t.block_start&&(o(t,!1),0===t.strm.avail_out)?vt:vt}function c(t,e){for(var a,i;;){if(t.lookahead<ft){if(_(t),t.lookahead<ft&&e===I)return vt;if(0===t.lookahead)break}if(a=0,t.lookahead>=ht&&(t.ins_h=(t.ins_h<<t.hash_shift^t.window[t.strstart+ht-1])&t.hash_mask,a=t.prev[t.strstart&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=t.strstart),0!==a&&t.strstart-a<=t.w_size-ft&&(t.match_length=f(t,a)),t.match_length>=ht)if(i=C._tr_tally(t,t.strstart-t.match_start,t.match_length-ht),t.lookahead-=t.match_length,t.match_length<=t.max_lazy_match&&t.lookahead>=ht){t.match_length--;do t.strstart++,t.ins_h=(t.ins_h<<t.hash_shift^t.window[t.strstart+ht-1])&t.hash_mask,a=t.prev[t.strstart&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=t.strstart;while(0!==--t.match_length);t.strstart++}else t.strstart+=t.match_length,t.match_length=0,t.ins_h=t.window[t.strstart],t.ins_h=(t.ins_h<<t.hash_shift^t.window[t.strstart+1])&t.hash_mask;else i=C._tr_tally(t,0,t.window[t.strstart]),t.lookahead--,t.strstart++;if(i&&(o(t,!1),0===t.strm.avail_out))return vt}return t.insert=t.strstart<ht-1?t.strstart:ht-1,e===F?(o(t,!0),0===t.strm.avail_out?yt:xt):t.last_lit&&(o(t,!1),0===t.strm.avail_out)?vt:kt}function b(t,e){for(var a,i,n;;){if(t.lookahead<ft){if(_(t),t.lookahead<ft&&e===I)return vt;if(0===t.lookahead)break}if(a=0,t.lookahead>=ht&&(t.ins_h=(t.ins_h<<t.hash_shift^t.window[t.strstart+ht-1])&t.hash_mask,a=t.prev[t.strstart&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=t.strstart),t.prev_length=t.match_length,t.prev_match=t.match_start,t.match_length=ht-1,0!==a&&t.prev_length<t.max_lazy_match&&t.strstart-a<=t.w_size-ft&&(t.match_length=f(t,a),t.match_length<=5&&(t.strategy===q||t.match_length===ht&&t.strstart-t.match_start>4096)&&(t.match_length=ht-1)),t.prev_length>=ht&&t.match_length<=t.prev_length){n=t.strstart+t.lookahead-ht,i=C._tr_tally(t,t.strstart-1-t.prev_match,t.prev_length-ht),t.lookahead-=t.prev_length-1,t.prev_length-=2;do++t.strstart<=n&&(t.ins_h=(t.ins_h<<t.hash_shift^t.window[t.strstart+ht-1])&t.hash_mask,a=t.prev[t.strstart&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=t.strstart);while(0!==--t.prev_length);if(t.match_available=0,t.match_length=ht-1,t.strstart++,i&&(o(t,!1),0===t.strm.avail_out))return vt}else if(t.match_available){if(i=C._tr_tally(t,0,t.window[t.strstart-1]),i&&o(t,!1),t.strstart++,t.lookahead--,0===t.strm.avail_out)return vt}else t.match_available=1,t.strstart++,t.lookahead--}return t.match_available&&(i=C._tr_tally(t,0,t.window[t.strstart-1]),t.match_available=0),t.insert=t.strstart<ht-1?t.strstart:ht-1,e===F?(o(t,!0),0===t.strm.avail_out?yt:xt):t.last_lit&&(o(t,!1),0===t.strm.avail_out)?vt:kt}function g(t,e){for(var a,i,n,r,s=t.window;;){if(t.lookahead<=dt){if(_(t),t.lookahead<=dt&&e===I)return vt;if(0===t.lookahead)break}if(t.match_length=0,t.lookahead>=ht&&t.strstart>0&&(n=t.strstart-1,i=s[n],i===s[++n]&&i===s[++n]&&i===s[++n])){r=t.strstart+dt;do;while(i===s[++n]&&i===s[++n]&&i===s[++n]&&i===s[++n]&&i===s[++n]&&i===s[++n]&&i===s[++n]&&i===s[++n]&&n<r);t.match_length=dt-(r-n),t.match_length>t.lookahead&&(t.match_length=t.lookahead)}if(t.match_length>=ht?(a=C._tr_tally(t,1,t.match_length-ht),t.lookahead-=t.match_length,t.strstart+=t.match_length,t.match_length=0):(a=C._tr_tally(t,0,t.window[t.strstart]),t.lookahead--,t.strstart++),a&&(o(t,!1),0===t.strm.avail_out))return vt}return t.insert=0,e===F?(o(t,!0),0===t.strm.avail_out?yt:xt):t.last_lit&&(o(t,!1),0===t.strm.avail_out)?vt:kt}function m(t,e){for(var a;;){if(0===t.lookahead&&(_(t),0===t.lookahead)){if(e===I)return vt;break}if(t.match_length=0,a=C._tr_tally(t,0,t.window[t.strstart]),t.lookahead--,t.strstart++,a&&(o(t,!1),0===t.strm.avail_out))return vt}return t.insert=0,e===F?(o(t,!0),0===t.strm.avail_out?yt:xt):t.last_lit&&(o(t,!1),0===t.strm.avail_out)?vt:kt}function w(t,e,a,i,n){this.good_length=t,this.max_lazy=e,this.nice_length=a,this.max_chain=i,this.func=n}function p(t){t.window_size=2*t.w_size,r(t.head),t.max_lazy_match=Z[t.level].max_lazy,t.good_match=Z[t.level].good_length,t.nice_match=Z[t.level].nice_length,t.max_chain_length=Z[t.level].max_chain,t.strstart=0,t.block_start=0,t.lookahead=0,t.insert=0,t.match_length=t.prev_length=ht-1,t.match_available=0,t.ins_h=0}function v(){this.strm=null,this.status=0,this.pending_buf=null,this.pending_buf_size=0,this.pending_out=0,this.pending=0,this.wrap=0,this.gzhead=null,this.gzindex=0,this.method=V,this.last_flush=-1,this.w_size=0,this.w_bits=0,this.w_mask=0,this.window=null,this.window_size=0,this.prev=null,this.head=null,this.ins_h=0,this.hash_size=0,this.hash_bits=0,this.hash_mask=0,this.hash_shift=0,this.block_start=0,this.match_length=0,this.prev_match=0,this.match_available=0,this.strstart=0,this.match_start=0,this.lookahead=0,this.prev_length=0,this.max_chain_length=0,this.max_lazy_match=0,this.level=0,this.strategy=0,this.good_match=0,this.nice_match=0,this.dyn_ltree=new R.Buf16(2*ot),this.dyn_dtree=new R.Buf16(2*(2*rt+1)),this.bl_tree=new R.Buf16(2*(2*st+1)),r(this.dyn_ltree),r(this.dyn_dtree),r(this.bl_tree),this.l_desc=null,this.d_desc=null,this.bl_desc=null,this.bl_count=new R.Buf16(lt+1),this.heap=new R.Buf16(2*nt+1),r(this.heap),this.heap_len=0,this.heap_max=0,this.depth=new R.Buf16(2*nt+1),r(this.depth),this.l_buf=0,this.lit_bufsize=0,this.last_lit=0,this.d_buf=0,this.opt_len=0,this.static_len=0,this.matches=0,this.insert=0,this.bi_buf=0,this.bi_valid=0}function k(t){var e;return t&&t.state?(t.total_in=t.total_out=0,t.data_type=Q,e=t.state,e.pending=0,e.pending_out=0,e.wrap<0&&(e.wrap=-e.wrap),e.status=e.wrap?ut:wt,t.adler=2===e.wrap?0:1,e.last_flush=I,C._tr_init(e),H):i(t,K)}function y(t){var e=k(t);return e===H&&p(t.state),e}function x(t,e){return t&&t.state?2!==t.state.wrap?K:(t.state.gzhead=e,H):K}function z(t,e,a,n,r,s){if(!t)return K;var o=1;if(e===Y&&(e=6),n<0?(o=0,n=-n):n>15&&(o=2,n-=16),r<1||r>$||a!==V||n<8||n>15||e<0||e>9||s<0||s>W)return i(t,K);8===n&&(n=9);var l=new v;return t.state=l,l.strm=t,l.wrap=o,l.gzhead=null,l.w_bits=n,l.w_size=1<<l.w_bits,l.w_mask=l.w_size-1,l.hash_bits=r+7,l.hash_size=1<<l.hash_bits,l.hash_mask=l.hash_size-1,l.hash_shift=~~((l.hash_bits+ht-1)/ht),l.window=new R.Buf8(2*l.w_size),l.head=new R.Buf16(l.hash_size),l.prev=new R.Buf16(l.w_size),l.lit_bufsize=1<<r+6,l.pending_buf_size=4*l.lit_bufsize,l.pending_buf=new R.Buf8(l.pending_buf_size),l.d_buf=1*l.lit_bufsize,l.l_buf=3*l.lit_bufsize,l.level=e,l.strategy=s,l.method=a,y(t)}function B(t,e){return z(t,e,V,tt,et,J)}function S(t,e){var a,o,d,f;if(!t||!t.state||e>L||e<0)return t?i(t,K):K;if(o=t.state,!t.output||!t.input&&0!==t.avail_in||o.status===pt&&e!==F)return i(t,0===t.avail_out?P:K);if(o.strm=t,a=o.last_flush,o.last_flush=e,o.status===ut)if(2===o.wrap)t.adler=0,l(o,31),l(o,139),l(o,8),o.gzhead?(l(o,(o.gzhead.text?1:0)+(o.gzhead.hcrc?2:0)+(o.gzhead.extra?4:0)+(o.gzhead.name?8:0)+(o.gzhead.comment?16:0)),l(o,255&o.gzhead.time),l(o,o.gzhead.time>>8&255),l(o,o.gzhead.time>>16&255),l(o,o.gzhead.time>>24&255),l(o,9===o.level?2:o.strategy>=G||o.level<2?4:0),l(o,255&o.gzhead.os),o.gzhead.extra&&o.gzhead.extra.length&&(l(o,255&o.gzhead.extra.length),l(o,o.gzhead.extra.length>>8&255)),o.gzhead.hcrc&&(t.adler=O(t.adler,o.pending_buf,o.pending,0)),o.gzindex=0,o.status=ct):(l(o,0),l(o,0),l(o,0),l(o,0),l(o,0),l(o,9===o.level?2:o.strategy>=G||o.level<2?4:0),l(o,zt),o.status=wt);else{var _=V+(o.w_bits-8<<4)<<8,u=-1;u=o.strategy>=G||o.level<2?0:o.level<6?1:6===o.level?2:3,_|=u<<6,0!==o.strstart&&(_|=_t),_+=31-_%31,o.status=wt,h(o,_),0!==o.strstart&&(h(o,t.adler>>>16),h(o,65535&t.adler)),t.adler=1}if(o.status===ct)if(o.gzhead.extra){for(d=o.pending;o.gzindex<(65535&o.gzhead.extra.length)&&(o.pending!==o.pending_buf_size||(o.gzhead.hcrc&&o.pending>d&&(t.adler=O(t.adler,o.pending_buf,o.pending-d,d)),s(t),d=o.pending,o.pending!==o.pending_buf_size));)l(o,255&o.gzhead.extra[o.gzindex]),o.gzindex++;o.gzhead.hcrc&&o.pending>d&&(t.adler=O(t.adler,o.pending_buf,o.pending-d,d)),o.gzindex===o.gzhead.extra.length&&(o.gzindex=0,o.status=bt)}else o.status=bt;if(o.status===bt)if(o.gzhead.name){d=o.pending;do{if(o.pending===o.pending_buf_size&&(o.gzhead.hcrc&&o.pending>d&&(t.adler=O(t.adler,o.pending_buf,o.pending-d,d)),s(t),d=o.pending,o.pending===o.pending_buf_size)){f=1;break}f=o.gzindex<o.gzhead.name.length?255&o.gzhead.name.charCodeAt(o.gzindex++):0,l(o,f)}while(0!==f);o.gzhead.hcrc&&o.pending>d&&(t.adler=O(t.adler,o.pending_buf,o.pending-d,d)),0===f&&(o.gzindex=0,o.status=gt)}else o.status=gt;if(o.status===gt)if(o.gzhead.comment){d=o.pending;do{if(o.pending===o.pending_buf_size&&(o.gzhead.hcrc&&o.pending>d&&(t.adler=O(t.adler,o.pending_buf,o.pending-d,d)),s(t),d=o.pending,o.pending===o.pending_buf_size)){f=1;break}f=o.gzindex<o.gzhead.comment.length?255&o.gzhead.comment.charCodeAt(o.gzindex++):0,l(o,f)}while(0!==f);o.gzhead.hcrc&&o.pending>d&&(t.adler=O(t.adler,o.pending_buf,o.pending-d,d)),0===f&&(o.status=mt)}else o.status=mt;if(o.status===mt&&(o.gzhead.hcrc?(o.pending+2>o.pending_buf_size&&s(t),o.pending+2<=o.pending_buf_size&&(l(o,255&t.adler),l(o,t.adler>>8&255),t.adler=0,o.status=wt)):o.status=wt),0!==o.pending){if(s(t),0===t.avail_out)return o.last_flush=-1,H}else if(0===t.avail_in&&n(e)<=n(a)&&e!==F)return i(t,P);if(o.status===pt&&0!==t.avail_in)return i(t,P);if(0!==t.avail_in||0!==o.lookahead||e!==I&&o.status!==pt){var c=o.strategy===G?m(o,e):o.strategy===X?g(o,e):Z[o.level].func(o,e);if(c!==yt&&c!==xt||(o.status=pt),c===vt||c===yt)return 0===t.avail_out&&(o.last_flush=-1),H;if(c===kt&&(e===U?C._tr_align(o):e!==L&&(C._tr_stored_block(o,0,0,!1),e===T&&(r(o.head),0===o.lookahead&&(o.strstart=0,o.block_start=0,o.insert=0))),s(t),0===t.avail_out))return o.last_flush=-1,H}return e!==F?H:o.wrap<=0?j:(2===o.wrap?(l(o,255&t.adler),l(o,t.adler>>8&255),l(o,t.adler>>16&255),l(o,t.adler>>24&255),l(o,255&t.total_in),l(o,t.total_in>>8&255),l(o,t.total_in>>16&255),l(o,t.total_in>>24&255)):(h(o,t.adler>>>16),h(o,65535&t.adler)),s(t),o.wrap>0&&(o.wrap=-o.wrap),0!==o.pending?H:j)}function E(t){var e;return t&&t.state?(e=t.state.status,e!==ut&&e!==ct&&e!==bt&&e!==gt&&e!==mt&&e!==wt&&e!==pt?i(t,K):(t.state=null,e===wt?i(t,M):H)):K}function A(t,e){var a,i,n,s,o,l,h,d,f=e.length;if(!t||!t.state)return K;if(a=t.state,s=a.wrap,2===s||1===s&&a.status!==ut||a.lookahead)return K;for(1===s&&(t.adler=N(t.adler,e,f,0)),a.wrap=0,f>=a.w_size&&(0===s&&(r(a.head),a.strstart=0,a.block_start=0,a.insert=0),d=new R.Buf8(a.w_size),R.arraySet(d,e,f-a.w_size,a.w_size,0),e=d,f=a.w_size),o=t.avail_in,l=t.next_in,h=t.input,t.avail_in=f,t.next_in=0,t.input=e,_(a);a.lookahead>=ht;){i=a.strstart,n=a.lookahead-(ht-1);do a.ins_h=(a.ins_h<<a.hash_shift^a.window[i+ht-1])&a.hash_mask,a.prev[i&a.w_mask]=a.head[a.ins_h],a.head[a.ins_h]=i,i++;while(--n);a.strstart=i,a.lookahead=ht-1,_(a)}return a.strstart+=a.lookahead,a.block_start=a.strstart,a.insert=a.lookahead,a.lookahead=0,a.match_length=a.prev_length=ht-1,a.match_available=0,t.next_in=l,t.input=h,t.avail_in=o,a.wrap=s,H}var Z,R=t("../utils/common"),C=t("./trees"),N=t("./adler32"),O=t("./crc32"),D=t("./messages"),I=0,U=1,T=3,F=4,L=5,H=0,j=1,K=-2,M=-3,P=-5,Y=-1,q=1,G=2,X=3,W=4,J=0,Q=2,V=8,$=9,tt=15,et=8,at=29,it=256,nt=it+1+at,rt=30,st=19,ot=2*nt+1,lt=15,ht=3,dt=258,ft=dt+ht+1,_t=32,ut=42,ct=69,bt=73,gt=91,mt=103,wt=113,pt=666,vt=1,kt=2,yt=3,xt=4,zt=3;Z=[new w(0,0,0,0,u),new w(4,4,8,4,c),new w(4,5,16,8,c),new w(4,6,32,32,c),new w(4,4,16,16,b),new w(8,16,32,32,b),new w(8,16,128,128,b),new w(8,32,128,256,b),new w(32,128,258,1024,b),new w(32,258,258,4096,b)],a.deflateInit=B,a.deflateInit2=z,a.deflateReset=y,a.deflateResetKeep=k,a.deflateSetHeader=x,a.deflate=S,a.deflateEnd=E,a.deflateSetDictionary=A,a.deflateInfo="pako deflate (from Nodeca project)"},{"../utils/common":3,"./adler32":5,"./crc32":7,"./messages":13,"./trees":14}],9:[function(t,e,a){"use strict";function i(){this.text=0,this.time=0,this.xflags=0,this.os=0,this.extra=null,this.extra_len=0,this.name="",this.comment="",this.hcrc=0,this.done=!1}e.exports=i},{}],10:[function(t,e,a){"use strict";var i=30,n=12;e.exports=function(t,e){var a,r,s,o,l,h,d,f,_,u,c,b,g,m,w,p,v,k,y,x,z,B,S,E,A;a=t.state,r=t.next_in,E=t.input,s=r+(t.avail_in-5),o=t.next_out,A=t.output,l=o-(e-t.avail_out),h=o+(t.avail_out-257),d=a.dmax,f=a.wsize,_=a.whave,u=a.wnext,c=a.window,b=a.hold,g=a.bits,m=a.lencode,w=a.distcode,p=(1<<a.lenbits)-1,v=(1<<a.distbits)-1;t:do{g<15&&(b+=E[r++]<<g,g+=8,b+=E[r++]<<g,g+=8),k=m[b&p];e:for(;;){if(y=k>>>24,b>>>=y,g-=y,y=k>>>16&255,0===y)A[o++]=65535&k;else{if(!(16&y)){if(0===(64&y)){k=m[(65535&k)+(b&(1<<y)-1)];continue e}if(32&y){a.mode=n;break t}t.msg="invalid literal/length code",a.mode=i;break t}x=65535&k,y&=15,y&&(g<y&&(b+=E[r++]<<g,g+=8),x+=b&(1<<y)-1,b>>>=y,g-=y),g<15&&(b+=E[r++]<<g,g+=8,b+=E[r++]<<g,g+=8),k=w[b&v];a:for(;;){if(y=k>>>24,b>>>=y,g-=y,y=k>>>16&255,!(16&y)){if(0===(64&y)){k=w[(65535&k)+(b&(1<<y)-1)];continue a}t.msg="invalid distance code",a.mode=i;break t}if(z=65535&k,y&=15,g<y&&(b+=E[r++]<<g,g+=8,g<y&&(b+=E[r++]<<g,g+=8)),z+=b&(1<<y)-1,z>d){t.msg="invalid distance too far back",a.mode=i;break t}if(b>>>=y,g-=y,y=o-l,z>y){if(y=z-y,y>_&&a.sane){t.msg="invalid distance too far back",a.mode=i;break t}if(B=0,S=c,0===u){if(B+=f-y,y<x){x-=y;do A[o++]=c[B++];while(--y);B=o-z,S=A}}else if(u<y){if(B+=f+u-y,y-=u,y<x){x-=y;do A[o++]=c[B++];while(--y);if(B=0,u<x){y=u,x-=y;do A[o++]=c[B++];while(--y);B=o-z,S=A}}}else if(B+=u-y,y<x){x-=y;do A[o++]=c[B++];while(--y);B=o-z,S=A}for(;x>2;)A[o++]=S[B++],A[o++]=S[B++],A[o++]=S[B++],x-=3;x&&(A[o++]=S[B++],x>1&&(A[o++]=S[B++]))}else{B=o-z;do A[o++]=A[B++],A[o++]=A[B++],A[o++]=A[B++],x-=3;while(x>2);x&&(A[o++]=A[B++],x>1&&(A[o++]=A[B++]))}break}}break}}while(r<s&&o<h);x=g>>3,r-=x,g-=x<<3,b&=(1<<g)-1,t.next_in=r,t.next_out=o,t.avail_in=r<s?5+(s-r):5-(r-s),t.avail_out=o<h?257+(h-o):257-(o-h),a.hold=b,a.bits=g}},{}],11:[function(t,e,a){"use strict";function i(t){return(t>>>24&255)+(t>>>8&65280)+((65280&t)<<8)+((255&t)<<24)}function n(){this.mode=0,this.last=!1,this.wrap=0,this.havedict=!1,this.flags=0,this.dmax=0,this.check=0,this.total=0,this.head=null,this.wbits=0,this.wsize=0,this.whave=0,this.wnext=0,this.window=null,this.hold=0,this.bits=0,this.length=0,this.offset=0,this.extra=0,this.lencode=null,this.distcode=null,this.lenbits=0,this.distbits=0,this.ncode=0,this.nlen=0,this.ndist=0,this.have=0,this.next=null,this.lens=new w.Buf16(320),this.work=new w.Buf16(288),this.lendyn=null,this.distdyn=null,this.sane=0,this.back=0,this.was=0}function r(t){var e;return t&&t.state?(e=t.state,t.total_in=t.total_out=e.total=0,t.msg="",e.wrap&&(t.adler=1&e.wrap),e.mode=T,e.last=0,e.havedict=0,e.dmax=32768,e.head=null,e.hold=0,e.bits=0,e.lencode=e.lendyn=new w.Buf32(bt),e.distcode=e.distdyn=new w.Buf32(gt),e.sane=1,e.back=-1,Z):N}function s(t){var e;return t&&t.state?(e=t.state,e.wsize=0,e.whave=0,e.wnext=0,r(t)):N}function o(t,e){var a,i;return t&&t.state?(i=t.state,e<0?(a=0,e=-e):(a=(e>>4)+1,e<48&&(e&=15)),e&&(e<8||e>15)?N:(null!==i.window&&i.wbits!==e&&(i.window=null),i.wrap=a,i.wbits=e,s(t))):N}function l(t,e){var a,i;return t?(i=new n,t.state=i,i.window=null,a=o(t,e),a!==Z&&(t.state=null),a):N}function h(t){return l(t,wt)}function d(t){if(pt){var e;for(g=new w.Buf32(512),m=new w.Buf32(32),e=0;e<144;)t.lens[e++]=8;for(;e<256;)t.lens[e++]=9;for(;e<280;)t.lens[e++]=7;for(;e<288;)t.lens[e++]=8;for(y(z,t.lens,0,288,g,0,t.work,{bits:9}),e=0;e<32;)t.lens[e++]=5;y(B,t.lens,0,32,m,0,t.work,{bits:5}),pt=!1}t.lencode=g,t.lenbits=9,t.distcode=m,t.distbits=5}function f(t,e,a,i){var n,r=t.state;return null===r.window&&(r.wsize=1<<r.wbits,r.wnext=0,r.whave=0,r.window=new w.Buf8(r.wsize)),i>=r.wsize?(w.arraySet(r.window,e,a-r.wsize,r.wsize,0),r.wnext=0,r.whave=r.wsize):(n=r.wsize-r.wnext,n>i&&(n=i),w.arraySet(r.window,e,a-i,n,r.wnext),i-=n,i?(w.arraySet(r.window,e,a-i,i,0),r.wnext=i,r.whave=r.wsize):(r.wnext+=n,r.wnext===r.wsize&&(r.wnext=0),r.whave<r.wsize&&(r.whave+=n))),0}function _(t,e){var a,n,r,s,o,l,h,_,u,c,b,g,m,bt,gt,mt,wt,pt,vt,kt,yt,xt,zt,Bt,St=0,Et=new w.Buf8(4),At=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];if(!t||!t.state||!t.output||!t.input&&0!==t.avail_in)return N;a=t.state,a.mode===X&&(a.mode=W),o=t.next_out,r=t.output,h=t.avail_out,s=t.next_in,n=t.input,l=t.avail_in,_=a.hold,u=a.bits,c=l,b=h,xt=Z;t:for(;;)switch(a.mode){case T:if(0===a.wrap){a.mode=W;break}for(;u<16;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}if(2&a.wrap&&35615===_){a.check=0,Et[0]=255&_,Et[1]=_>>>8&255,a.check=v(a.check,Et,2,0),_=0,u=0,a.mode=F;break}if(a.flags=0,a.head&&(a.head.done=!1),!(1&a.wrap)||(((255&_)<<8)+(_>>8))%31){t.msg="incorrect header check",a.mode=_t;break}if((15&_)!==U){t.msg="unknown compression method",a.mode=_t;break}if(_>>>=4,u-=4,yt=(15&_)+8,0===a.wbits)a.wbits=yt;else if(yt>a.wbits){t.msg="invalid window size",a.mode=_t;break}a.dmax=1<<yt,t.adler=a.check=1,a.mode=512&_?q:X,_=0,u=0;break;case F:for(;u<16;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}if(a.flags=_,(255&a.flags)!==U){t.msg="unknown compression method",a.mode=_t;break}if(57344&a.flags){t.msg="unknown header flags set",a.mode=_t;break}a.head&&(a.head.text=_>>8&1),512&a.flags&&(Et[0]=255&_,Et[1]=_>>>8&255,a.check=v(a.check,Et,2,0)),_=0,u=0,a.mode=L;case L:for(;u<32;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}a.head&&(a.head.time=_),512&a.flags&&(Et[0]=255&_,Et[1]=_>>>8&255,Et[2]=_>>>16&255,Et[3]=_>>>24&255,a.check=v(a.check,Et,4,0)),_=0,u=0,a.mode=H;case H:for(;u<16;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}a.head&&(a.head.xflags=255&_,a.head.os=_>>8),512&a.flags&&(Et[0]=255&_,Et[1]=_>>>8&255,a.check=v(a.check,Et,2,0)),_=0,u=0,a.mode=j;case j:if(1024&a.flags){for(;u<16;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}a.length=_,a.head&&(a.head.extra_len=_),512&a.flags&&(Et[0]=255&_,Et[1]=_>>>8&255,a.check=v(a.check,Et,2,0)),_=0,u=0}else a.head&&(a.head.extra=null);a.mode=K;case K:if(1024&a.flags&&(g=a.length,g>l&&(g=l),g&&(a.head&&(yt=a.head.extra_len-a.length,a.head.extra||(a.head.extra=new Array(a.head.extra_len)),w.arraySet(a.head.extra,n,s,g,yt)),512&a.flags&&(a.check=v(a.check,n,g,s)),l-=g,s+=g,a.length-=g),a.length))break t;a.length=0,a.mode=M;case M:if(2048&a.flags){if(0===l)break t;g=0;do yt=n[s+g++],a.head&&yt&&a.length<65536&&(a.head.name+=String.fromCharCode(yt));while(yt&&g<l);if(512&a.flags&&(a.check=v(a.check,n,g,s)),l-=g,s+=g,yt)break t}else a.head&&(a.head.name=null);a.length=0,a.mode=P;case P:if(4096&a.flags){if(0===l)break t;g=0;do yt=n[s+g++],a.head&&yt&&a.length<65536&&(a.head.comment+=String.fromCharCode(yt));while(yt&&g<l);if(512&a.flags&&(a.check=v(a.check,n,g,s)),l-=g,s+=g,yt)break t}else a.head&&(a.head.comment=null);a.mode=Y;case Y:if(512&a.flags){for(;u<16;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}if(_!==(65535&a.check)){t.msg="header crc mismatch",a.mode=_t;break}_=0,u=0}a.head&&(a.head.hcrc=a.flags>>9&1,a.head.done=!0),t.adler=a.check=0,a.mode=X;break;case q:for(;u<32;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}t.adler=a.check=i(_),_=0,u=0,a.mode=G;case G:if(0===a.havedict)return t.next_out=o,t.avail_out=h,t.next_in=s,t.avail_in=l,a.hold=_,a.bits=u,C;t.adler=a.check=1,a.mode=X;case X:if(e===E||e===A)break t;case W:if(a.last){_>>>=7&u,u-=7&u,a.mode=ht;break}for(;u<3;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}switch(a.last=1&_,_>>>=1,u-=1,3&_){case 0:a.mode=J;break;case 1:if(d(a),a.mode=at,e===A){_>>>=2,u-=2;break t}break;case 2:a.mode=$;break;case 3:t.msg="invalid block type",a.mode=_t}_>>>=2,u-=2;break;case J:for(_>>>=7&u,u-=7&u;u<32;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}if((65535&_)!==(_>>>16^65535)){t.msg="invalid stored block lengths",a.mode=_t;break}if(a.length=65535&_,_=0,u=0,a.mode=Q,e===A)break t;case Q:a.mode=V;case V:if(g=a.length){if(g>l&&(g=l),g>h&&(g=h),0===g)break t;w.arraySet(r,n,s,g,o),l-=g,s+=g,h-=g,o+=g,a.length-=g;break}a.mode=X;break;case $:
for(;u<14;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}if(a.nlen=(31&_)+257,_>>>=5,u-=5,a.ndist=(31&_)+1,_>>>=5,u-=5,a.ncode=(15&_)+4,_>>>=4,u-=4,a.nlen>286||a.ndist>30){t.msg="too many length or distance symbols",a.mode=_t;break}a.have=0,a.mode=tt;case tt:for(;a.have<a.ncode;){for(;u<3;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}a.lens[At[a.have++]]=7&_,_>>>=3,u-=3}for(;a.have<19;)a.lens[At[a.have++]]=0;if(a.lencode=a.lendyn,a.lenbits=7,zt={bits:a.lenbits},xt=y(x,a.lens,0,19,a.lencode,0,a.work,zt),a.lenbits=zt.bits,xt){t.msg="invalid code lengths set",a.mode=_t;break}a.have=0,a.mode=et;case et:for(;a.have<a.nlen+a.ndist;){for(;St=a.lencode[_&(1<<a.lenbits)-1],gt=St>>>24,mt=St>>>16&255,wt=65535&St,!(gt<=u);){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}if(wt<16)_>>>=gt,u-=gt,a.lens[a.have++]=wt;else{if(16===wt){for(Bt=gt+2;u<Bt;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}if(_>>>=gt,u-=gt,0===a.have){t.msg="invalid bit length repeat",a.mode=_t;break}yt=a.lens[a.have-1],g=3+(3&_),_>>>=2,u-=2}else if(17===wt){for(Bt=gt+3;u<Bt;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}_>>>=gt,u-=gt,yt=0,g=3+(7&_),_>>>=3,u-=3}else{for(Bt=gt+7;u<Bt;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}_>>>=gt,u-=gt,yt=0,g=11+(127&_),_>>>=7,u-=7}if(a.have+g>a.nlen+a.ndist){t.msg="invalid bit length repeat",a.mode=_t;break}for(;g--;)a.lens[a.have++]=yt}}if(a.mode===_t)break;if(0===a.lens[256]){t.msg="invalid code -- missing end-of-block",a.mode=_t;break}if(a.lenbits=9,zt={bits:a.lenbits},xt=y(z,a.lens,0,a.nlen,a.lencode,0,a.work,zt),a.lenbits=zt.bits,xt){t.msg="invalid literal/lengths set",a.mode=_t;break}if(a.distbits=6,a.distcode=a.distdyn,zt={bits:a.distbits},xt=y(B,a.lens,a.nlen,a.ndist,a.distcode,0,a.work,zt),a.distbits=zt.bits,xt){t.msg="invalid distances set",a.mode=_t;break}if(a.mode=at,e===A)break t;case at:a.mode=it;case it:if(l>=6&&h>=258){t.next_out=o,t.avail_out=h,t.next_in=s,t.avail_in=l,a.hold=_,a.bits=u,k(t,b),o=t.next_out,r=t.output,h=t.avail_out,s=t.next_in,n=t.input,l=t.avail_in,_=a.hold,u=a.bits,a.mode===X&&(a.back=-1);break}for(a.back=0;St=a.lencode[_&(1<<a.lenbits)-1],gt=St>>>24,mt=St>>>16&255,wt=65535&St,!(gt<=u);){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}if(mt&&0===(240&mt)){for(pt=gt,vt=mt,kt=wt;St=a.lencode[kt+((_&(1<<pt+vt)-1)>>pt)],gt=St>>>24,mt=St>>>16&255,wt=65535&St,!(pt+gt<=u);){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}_>>>=pt,u-=pt,a.back+=pt}if(_>>>=gt,u-=gt,a.back+=gt,a.length=wt,0===mt){a.mode=lt;break}if(32&mt){a.back=-1,a.mode=X;break}if(64&mt){t.msg="invalid literal/length code",a.mode=_t;break}a.extra=15&mt,a.mode=nt;case nt:if(a.extra){for(Bt=a.extra;u<Bt;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}a.length+=_&(1<<a.extra)-1,_>>>=a.extra,u-=a.extra,a.back+=a.extra}a.was=a.length,a.mode=rt;case rt:for(;St=a.distcode[_&(1<<a.distbits)-1],gt=St>>>24,mt=St>>>16&255,wt=65535&St,!(gt<=u);){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}if(0===(240&mt)){for(pt=gt,vt=mt,kt=wt;St=a.distcode[kt+((_&(1<<pt+vt)-1)>>pt)],gt=St>>>24,mt=St>>>16&255,wt=65535&St,!(pt+gt<=u);){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}_>>>=pt,u-=pt,a.back+=pt}if(_>>>=gt,u-=gt,a.back+=gt,64&mt){t.msg="invalid distance code",a.mode=_t;break}a.offset=wt,a.extra=15&mt,a.mode=st;case st:if(a.extra){for(Bt=a.extra;u<Bt;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}a.offset+=_&(1<<a.extra)-1,_>>>=a.extra,u-=a.extra,a.back+=a.extra}if(a.offset>a.dmax){t.msg="invalid distance too far back",a.mode=_t;break}a.mode=ot;case ot:if(0===h)break t;if(g=b-h,a.offset>g){if(g=a.offset-g,g>a.whave&&a.sane){t.msg="invalid distance too far back",a.mode=_t;break}g>a.wnext?(g-=a.wnext,m=a.wsize-g):m=a.wnext-g,g>a.length&&(g=a.length),bt=a.window}else bt=r,m=o-a.offset,g=a.length;g>h&&(g=h),h-=g,a.length-=g;do r[o++]=bt[m++];while(--g);0===a.length&&(a.mode=it);break;case lt:if(0===h)break t;r[o++]=a.length,h--,a.mode=it;break;case ht:if(a.wrap){for(;u<32;){if(0===l)break t;l--,_|=n[s++]<<u,u+=8}if(b-=h,t.total_out+=b,a.total+=b,b&&(t.adler=a.check=a.flags?v(a.check,r,b,o-b):p(a.check,r,b,o-b)),b=h,(a.flags?_:i(_))!==a.check){t.msg="incorrect data check",a.mode=_t;break}_=0,u=0}a.mode=dt;case dt:if(a.wrap&&a.flags){for(;u<32;){if(0===l)break t;l--,_+=n[s++]<<u,u+=8}if(_!==(4294967295&a.total)){t.msg="incorrect length check",a.mode=_t;break}_=0,u=0}a.mode=ft;case ft:xt=R;break t;case _t:xt=O;break t;case ut:return D;case ct:default:return N}return t.next_out=o,t.avail_out=h,t.next_in=s,t.avail_in=l,a.hold=_,a.bits=u,(a.wsize||b!==t.avail_out&&a.mode<_t&&(a.mode<ht||e!==S))&&f(t,t.output,t.next_out,b-t.avail_out)?(a.mode=ut,D):(c-=t.avail_in,b-=t.avail_out,t.total_in+=c,t.total_out+=b,a.total+=b,a.wrap&&b&&(t.adler=a.check=a.flags?v(a.check,r,b,t.next_out-b):p(a.check,r,b,t.next_out-b)),t.data_type=a.bits+(a.last?64:0)+(a.mode===X?128:0)+(a.mode===at||a.mode===Q?256:0),(0===c&&0===b||e===S)&&xt===Z&&(xt=I),xt)}function u(t){if(!t||!t.state)return N;var e=t.state;return e.window&&(e.window=null),t.state=null,Z}function c(t,e){var a;return t&&t.state?(a=t.state,0===(2&a.wrap)?N:(a.head=e,e.done=!1,Z)):N}function b(t,e){var a,i,n,r=e.length;return t&&t.state?(a=t.state,0!==a.wrap&&a.mode!==G?N:a.mode===G&&(i=1,i=p(i,e,r,0),i!==a.check)?O:(n=f(t,e,r,r))?(a.mode=ut,D):(a.havedict=1,Z)):N}var g,m,w=t("../utils/common"),p=t("./adler32"),v=t("./crc32"),k=t("./inffast"),y=t("./inftrees"),x=0,z=1,B=2,S=4,E=5,A=6,Z=0,R=1,C=2,N=-2,O=-3,D=-4,I=-5,U=8,T=1,F=2,L=3,H=4,j=5,K=6,M=7,P=8,Y=9,q=10,G=11,X=12,W=13,J=14,Q=15,V=16,$=17,tt=18,et=19,at=20,it=21,nt=22,rt=23,st=24,ot=25,lt=26,ht=27,dt=28,ft=29,_t=30,ut=31,ct=32,bt=852,gt=592,mt=15,wt=mt,pt=!0;a.inflateReset=s,a.inflateReset2=o,a.inflateResetKeep=r,a.inflateInit=h,a.inflateInit2=l,a.inflate=_,a.inflateEnd=u,a.inflateGetHeader=c,a.inflateSetDictionary=b,a.inflateInfo="pako inflate (from Nodeca project)"},{"../utils/common":3,"./adler32":5,"./crc32":7,"./inffast":10,"./inftrees":12}],12:[function(t,e,a){"use strict";var i=t("../utils/common"),n=15,r=852,s=592,o=0,l=1,h=2,d=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258,0,0],f=[16,16,16,16,16,16,16,16,17,17,17,17,18,18,18,18,19,19,19,19,20,20,20,20,21,21,21,21,16,72,78],_=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577,0,0],u=[16,16,16,16,17,17,18,18,19,19,20,20,21,21,22,22,23,23,24,24,25,25,26,26,27,27,28,28,29,29,64,64];e.exports=function(t,e,a,c,b,g,m,w){var p,v,k,y,x,z,B,S,E,A=w.bits,Z=0,R=0,C=0,N=0,O=0,D=0,I=0,U=0,T=0,F=0,L=null,H=0,j=new i.Buf16(n+1),K=new i.Buf16(n+1),M=null,P=0;for(Z=0;Z<=n;Z++)j[Z]=0;for(R=0;R<c;R++)j[e[a+R]]++;for(O=A,N=n;N>=1&&0===j[N];N--);if(O>N&&(O=N),0===N)return b[g++]=20971520,b[g++]=20971520,w.bits=1,0;for(C=1;C<N&&0===j[C];C++);for(O<C&&(O=C),U=1,Z=1;Z<=n;Z++)if(U<<=1,U-=j[Z],U<0)return-1;if(U>0&&(t===o||1!==N))return-1;for(K[1]=0,Z=1;Z<n;Z++)K[Z+1]=K[Z]+j[Z];for(R=0;R<c;R++)0!==e[a+R]&&(m[K[e[a+R]]++]=R);if(t===o?(L=M=m,z=19):t===l?(L=d,H-=257,M=f,P-=257,z=256):(L=_,M=u,z=-1),F=0,R=0,Z=C,x=g,D=O,I=0,k=-1,T=1<<O,y=T-1,t===l&&T>r||t===h&&T>s)return 1;for(;;){B=Z-I,m[R]<z?(S=0,E=m[R]):m[R]>z?(S=M[P+m[R]],E=L[H+m[R]]):(S=96,E=0),p=1<<Z-I,v=1<<D,C=v;do v-=p,b[x+(F>>I)+v]=B<<24|S<<16|E|0;while(0!==v);for(p=1<<Z-1;F&p;)p>>=1;if(0!==p?(F&=p-1,F+=p):F=0,R++,0===--j[Z]){if(Z===N)break;Z=e[a+m[R]]}if(Z>O&&(F&y)!==k){for(0===I&&(I=O),x+=C,D=Z-I,U=1<<D;D+I<N&&(U-=j[D+I],!(U<=0));)D++,U<<=1;if(T+=1<<D,t===l&&T>r||t===h&&T>s)return 1;k=F&y,b[k]=O<<24|D<<16|x-g|0}}return 0!==F&&(b[x+F]=Z-I<<24|64<<16|0),w.bits=O,0}},{"../utils/common":3}],13:[function(t,e,a){"use strict";e.exports={2:"need dictionary",1:"stream end",0:"","-1":"file error","-2":"stream error","-3":"data error","-4":"insufficient memory","-5":"buffer error","-6":"incompatible version"}},{}],14:[function(t,e,a){"use strict";function i(t){for(var e=t.length;--e>=0;)t[e]=0}function n(t,e,a,i,n){this.static_tree=t,this.extra_bits=e,this.extra_base=a,this.elems=i,this.max_length=n,this.has_stree=t&&t.length}function r(t,e){this.dyn_tree=t,this.max_code=0,this.stat_desc=e}function s(t){return t<256?lt[t]:lt[256+(t>>>7)]}function o(t,e){t.pending_buf[t.pending++]=255&e,t.pending_buf[t.pending++]=e>>>8&255}function l(t,e,a){t.bi_valid>W-a?(t.bi_buf|=e<<t.bi_valid&65535,o(t,t.bi_buf),t.bi_buf=e>>W-t.bi_valid,t.bi_valid+=a-W):(t.bi_buf|=e<<t.bi_valid&65535,t.bi_valid+=a)}function h(t,e,a){l(t,a[2*e],a[2*e+1])}function d(t,e){var a=0;do a|=1&t,t>>>=1,a<<=1;while(--e>0);return a>>>1}function f(t){16===t.bi_valid?(o(t,t.bi_buf),t.bi_buf=0,t.bi_valid=0):t.bi_valid>=8&&(t.pending_buf[t.pending++]=255&t.bi_buf,t.bi_buf>>=8,t.bi_valid-=8)}function _(t,e){var a,i,n,r,s,o,l=e.dyn_tree,h=e.max_code,d=e.stat_desc.static_tree,f=e.stat_desc.has_stree,_=e.stat_desc.extra_bits,u=e.stat_desc.extra_base,c=e.stat_desc.max_length,b=0;for(r=0;r<=X;r++)t.bl_count[r]=0;for(l[2*t.heap[t.heap_max]+1]=0,a=t.heap_max+1;a<G;a++)i=t.heap[a],r=l[2*l[2*i+1]+1]+1,r>c&&(r=c,b++),l[2*i+1]=r,i>h||(t.bl_count[r]++,s=0,i>=u&&(s=_[i-u]),o=l[2*i],t.opt_len+=o*(r+s),f&&(t.static_len+=o*(d[2*i+1]+s)));if(0!==b){do{for(r=c-1;0===t.bl_count[r];)r--;t.bl_count[r]--,t.bl_count[r+1]+=2,t.bl_count[c]--,b-=2}while(b>0);for(r=c;0!==r;r--)for(i=t.bl_count[r];0!==i;)n=t.heap[--a],n>h||(l[2*n+1]!==r&&(t.opt_len+=(r-l[2*n+1])*l[2*n],l[2*n+1]=r),i--)}}function u(t,e,a){var i,n,r=new Array(X+1),s=0;for(i=1;i<=X;i++)r[i]=s=s+a[i-1]<<1;for(n=0;n<=e;n++){var o=t[2*n+1];0!==o&&(t[2*n]=d(r[o]++,o))}}function c(){var t,e,a,i,r,s=new Array(X+1);for(a=0,i=0;i<K-1;i++)for(dt[i]=a,t=0;t<1<<et[i];t++)ht[a++]=i;for(ht[a-1]=i,r=0,i=0;i<16;i++)for(ft[i]=r,t=0;t<1<<at[i];t++)lt[r++]=i;for(r>>=7;i<Y;i++)for(ft[i]=r<<7,t=0;t<1<<at[i]-7;t++)lt[256+r++]=i;for(e=0;e<=X;e++)s[e]=0;for(t=0;t<=143;)st[2*t+1]=8,t++,s[8]++;for(;t<=255;)st[2*t+1]=9,t++,s[9]++;for(;t<=279;)st[2*t+1]=7,t++,s[7]++;for(;t<=287;)st[2*t+1]=8,t++,s[8]++;for(u(st,P+1,s),t=0;t<Y;t++)ot[2*t+1]=5,ot[2*t]=d(t,5);_t=new n(st,et,M+1,P,X),ut=new n(ot,at,0,Y,X),ct=new n(new Array(0),it,0,q,J)}function b(t){var e;for(e=0;e<P;e++)t.dyn_ltree[2*e]=0;for(e=0;e<Y;e++)t.dyn_dtree[2*e]=0;for(e=0;e<q;e++)t.bl_tree[2*e]=0;t.dyn_ltree[2*Q]=1,t.opt_len=t.static_len=0,t.last_lit=t.matches=0}function g(t){t.bi_valid>8?o(t,t.bi_buf):t.bi_valid>0&&(t.pending_buf[t.pending++]=t.bi_buf),t.bi_buf=0,t.bi_valid=0}function m(t,e,a,i){g(t),i&&(o(t,a),o(t,~a)),N.arraySet(t.pending_buf,t.window,e,a,t.pending),t.pending+=a}function w(t,e,a,i){var n=2*e,r=2*a;return t[n]<t[r]||t[n]===t[r]&&i[e]<=i[a]}function p(t,e,a){for(var i=t.heap[a],n=a<<1;n<=t.heap_len&&(n<t.heap_len&&w(e,t.heap[n+1],t.heap[n],t.depth)&&n++,!w(e,i,t.heap[n],t.depth));)t.heap[a]=t.heap[n],a=n,n<<=1;t.heap[a]=i}function v(t,e,a){var i,n,r,o,d=0;if(0!==t.last_lit)do i=t.pending_buf[t.d_buf+2*d]<<8|t.pending_buf[t.d_buf+2*d+1],n=t.pending_buf[t.l_buf+d],d++,0===i?h(t,n,e):(r=ht[n],h(t,r+M+1,e),o=et[r],0!==o&&(n-=dt[r],l(t,n,o)),i--,r=s(i),h(t,r,a),o=at[r],0!==o&&(i-=ft[r],l(t,i,o)));while(d<t.last_lit);h(t,Q,e)}function k(t,e){var a,i,n,r=e.dyn_tree,s=e.stat_desc.static_tree,o=e.stat_desc.has_stree,l=e.stat_desc.elems,h=-1;for(t.heap_len=0,t.heap_max=G,a=0;a<l;a++)0!==r[2*a]?(t.heap[++t.heap_len]=h=a,t.depth[a]=0):r[2*a+1]=0;for(;t.heap_len<2;)n=t.heap[++t.heap_len]=h<2?++h:0,r[2*n]=1,t.depth[n]=0,t.opt_len--,o&&(t.static_len-=s[2*n+1]);for(e.max_code=h,a=t.heap_len>>1;a>=1;a--)p(t,r,a);n=l;do a=t.heap[1],t.heap[1]=t.heap[t.heap_len--],p(t,r,1),i=t.heap[1],t.heap[--t.heap_max]=a,t.heap[--t.heap_max]=i,r[2*n]=r[2*a]+r[2*i],t.depth[n]=(t.depth[a]>=t.depth[i]?t.depth[a]:t.depth[i])+1,r[2*a+1]=r[2*i+1]=n,t.heap[1]=n++,p(t,r,1);while(t.heap_len>=2);t.heap[--t.heap_max]=t.heap[1],_(t,e),u(r,h,t.bl_count)}function y(t,e,a){var i,n,r=-1,s=e[1],o=0,l=7,h=4;for(0===s&&(l=138,h=3),e[2*(a+1)+1]=65535,i=0;i<=a;i++)n=s,s=e[2*(i+1)+1],++o<l&&n===s||(o<h?t.bl_tree[2*n]+=o:0!==n?(n!==r&&t.bl_tree[2*n]++,t.bl_tree[2*V]++):o<=10?t.bl_tree[2*$]++:t.bl_tree[2*tt]++,o=0,r=n,0===s?(l=138,h=3):n===s?(l=6,h=3):(l=7,h=4))}function x(t,e,a){var i,n,r=-1,s=e[1],o=0,d=7,f=4;for(0===s&&(d=138,f=3),i=0;i<=a;i++)if(n=s,s=e[2*(i+1)+1],!(++o<d&&n===s)){if(o<f){do h(t,n,t.bl_tree);while(0!==--o)}else 0!==n?(n!==r&&(h(t,n,t.bl_tree),o--),h(t,V,t.bl_tree),l(t,o-3,2)):o<=10?(h(t,$,t.bl_tree),l(t,o-3,3)):(h(t,tt,t.bl_tree),l(t,o-11,7));o=0,r=n,0===s?(d=138,f=3):n===s?(d=6,f=3):(d=7,f=4)}}function z(t){var e;for(y(t,t.dyn_ltree,t.l_desc.max_code),y(t,t.dyn_dtree,t.d_desc.max_code),k(t,t.bl_desc),e=q-1;e>=3&&0===t.bl_tree[2*nt[e]+1];e--);return t.opt_len+=3*(e+1)+5+5+4,e}function B(t,e,a,i){var n;for(l(t,e-257,5),l(t,a-1,5),l(t,i-4,4),n=0;n<i;n++)l(t,t.bl_tree[2*nt[n]+1],3);x(t,t.dyn_ltree,e-1),x(t,t.dyn_dtree,a-1)}function S(t){var e,a=4093624447;for(e=0;e<=31;e++,a>>>=1)if(1&a&&0!==t.dyn_ltree[2*e])return D;if(0!==t.dyn_ltree[18]||0!==t.dyn_ltree[20]||0!==t.dyn_ltree[26])return I;for(e=32;e<M;e++)if(0!==t.dyn_ltree[2*e])return I;return D}function E(t){bt||(c(),bt=!0),t.l_desc=new r(t.dyn_ltree,_t),t.d_desc=new r(t.dyn_dtree,ut),t.bl_desc=new r(t.bl_tree,ct),t.bi_buf=0,t.bi_valid=0,b(t)}function A(t,e,a,i){l(t,(T<<1)+(i?1:0),3),m(t,e,a,!0)}function Z(t){l(t,F<<1,3),h(t,Q,st),f(t)}function R(t,e,a,i){var n,r,s=0;t.level>0?(t.strm.data_type===U&&(t.strm.data_type=S(t)),k(t,t.l_desc),k(t,t.d_desc),s=z(t),n=t.opt_len+3+7>>>3,r=t.static_len+3+7>>>3,r<=n&&(n=r)):n=r=a+5,a+4<=n&&e!==-1?A(t,e,a,i):t.strategy===O||r===n?(l(t,(F<<1)+(i?1:0),3),v(t,st,ot)):(l(t,(L<<1)+(i?1:0),3),B(t,t.l_desc.max_code+1,t.d_desc.max_code+1,s+1),v(t,t.dyn_ltree,t.dyn_dtree)),b(t),i&&g(t)}function C(t,e,a){return t.pending_buf[t.d_buf+2*t.last_lit]=e>>>8&255,t.pending_buf[t.d_buf+2*t.last_lit+1]=255&e,t.pending_buf[t.l_buf+t.last_lit]=255&a,t.last_lit++,0===e?t.dyn_ltree[2*a]++:(t.matches++,e--,t.dyn_ltree[2*(ht[a]+M+1)]++,t.dyn_dtree[2*s(e)]++),t.last_lit===t.lit_bufsize-1}var N=t("../utils/common"),O=4,D=0,I=1,U=2,T=0,F=1,L=2,H=3,j=258,K=29,M=256,P=M+1+K,Y=30,q=19,G=2*P+1,X=15,W=16,J=7,Q=256,V=16,$=17,tt=18,et=[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0],at=[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13],it=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,3,7],nt=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15],rt=512,st=new Array(2*(P+2));i(st);var ot=new Array(2*Y);i(ot);var lt=new Array(rt);i(lt);var ht=new Array(j-H+1);i(ht);var dt=new Array(K);i(dt);var ft=new Array(Y);i(ft);var _t,ut,ct,bt=!1;a._tr_init=E,a._tr_stored_block=A,a._tr_flush_block=R,a._tr_tally=C,a._tr_align=Z},{"../utils/common":3}],15:[function(t,e,a){"use strict";function i(){this.input=null,this.next_in=0,this.avail_in=0,this.total_in=0,this.output=null,this.next_out=0,this.avail_out=0,this.total_out=0,this.msg="",this.state=null,this.data_type=2,this.adler=0}e.exports=i},{}],"/":[function(t,e,a){"use strict";var i=t("./lib/utils/common").assign,n=t("./lib/deflate"),r=t("./lib/inflate"),s=t("./lib/zlib/constants"),o={};i(o,n,r,s),e.exports=o},{"./lib/deflate":1,"./lib/inflate":2,"./lib/utils/common":3,"./lib/zlib/constants":6}]},{},[])("/")});
/**
 * @license
 * Copyright 2015 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
function loadURLasArrayBuffer(path, callback) {
    if (path.indexOf("data:") === 0) {
        var offset = path.indexOf("base64,") + 7;
        var data = atob(path.substring(offset));
        var arr = new Uint8Array(data.length);
        for (var i = data.length - 1; i >= 0; i--) {
            arr[i] = data.charCodeAt(i);
        }
        callback(arr.buffer);
        return;
    }
    var xhr = new XMLHttpRequest();
    xhr.open("GET", path, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = function() {
        callback(xhr.response);
    };
    xhr.send(null);
}

var JpegImage = function jpegImage() {
    function JpegImage() {
        this._src = null;
        this._parser = new PDFJS.JpegImage();
        this.onload = null;
    }
    JpegImage.prototype = {
        get src() {
            return this._src;
        },
        set src(value) {
            this.load(value);
        },
        get width() {
            return this._parser.width;
        },
        get height() {
            return this._parser.height;
        },
        load: function load(path) {
            this._src = path;
            loadURLasArrayBuffer(path, function(buffer) {
                this.parse(new Uint8Array(buffer));
                if (this.onload) {
                    this.onload();
                }
            }.bind(this));
        },
        parse: function(data) {
            this._parser.parse(data);
        },
        getData: function(width, height) {
            return this._parser.getData(width, height, false);
        },
        copyToImageData: function copyToImageData(imageData) {
            if (this._parser.numComponents === 2 || this._parser.numComponents > 4) {
                throw new Error("Unsupported amount of components");
            }
            var width = imageData.width, height = imageData.height;
            var imageDataBytes = width * height * 4;
            var imageDataArray = imageData.data;
            var i, j;
            if (this._parser.numComponents === 1) {
                var values = this._parser.getData(width, height, false);
                for (i = 0, j = 0; i < imageDataBytes; ) {
                    var value = values[j++];
                    imageDataArray[i++] = value;
                    imageDataArray[i++] = value;
                    imageDataArray[i++] = value;
                    imageDataArray[i++] = 255;
                }
                return;
            }
            var rgb = this._parser.getData(width, height, true);
            for (i = 0, j = 0; i < imageDataBytes; ) {
                imageDataArray[i++] = rgb[j++];
                imageDataArray[i++] = rgb[j++];
                imageDataArray[i++] = rgb[j++];
                imageDataArray[i++] = 255;
            }
        }
    };
    return JpegImage;
}();

if (typeof exports === "function") {
    module.exports = {
        JpegImage: JpegImage,
        JpegDecoder: JpegDecoder,
        JpxDecoder: JpxDecoder,
        Jbig2Decoder: Jbig2Decoder
    };
}

var PDFJS;

(function(PDFJS) {
    "use strict";
    
	var JpegImage = function JpegImageClosure() {
  var dctZigZag = new Uint8Array([0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]);
  var dctCos1 = 4017;
  var dctSin1 = 799;
  var dctCos3 = 3406;
  var dctSin3 = 2276;
  var dctCos6 = 1567;
  var dctSin6 = 3784;
  var dctSqrt2 = 5793;
  var dctSqrt1d2 = 2896;
  function JpegImage() {
    this.decodeTransform = null;
    this.colorTransform = -1;
  }
  function buildHuffmanTable(codeLengths, values) {
    var k = 0,
        code = [],
        i,
        j,
        length = 16;
    while (length > 0 && !codeLengths[length - 1]) {
      length--;
    }
    code.push({
      children: [],
      index: 0
    });
    var p = code[0],
        q;
    for (i = 0; i < length; i++) {
      for (j = 0; j < codeLengths[i]; j++) {
        p = code.pop();
        p.children[p.index] = values[k];
        while (p.index > 0) {
          p = code.pop();
        }
        p.index++;
        code.push(p);
        while (code.length <= i) {
          code.push(q = {
            children: [],
            index: 0
          });
          p.children[p.index] = q.children;
          p = q;
        }
        k++;
      }
      if (i + 1 < length) {
        code.push(q = {
          children: [],
          index: 0
        });
        p.children[p.index] = q.children;
        p = q;
      }
    }
    return code[0].children;
  }
  function getBlockBufferOffset(component, row, col) {
    return 64 * ((component.blocksPerLine + 1) * row + col);
  }
  function decodeScan(data, offset, frame, components, resetInterval, spectralStart, spectralEnd, successivePrev, successive) {
    var mcusPerLine = frame.mcusPerLine;
    var progressive = frame.progressive;
    var startOffset = offset,
        bitsData = 0,
        bitsCount = 0;
    function readBit() {
      if (bitsCount > 0) {
        bitsCount--;
        return bitsData >> bitsCount & 1;
      }
      bitsData = data[offset++];
      if (bitsData === 0xFF) {
        var nextByte = data[offset++];
        if (nextByte) {
          error('JPEG error: unexpected marker ' + (bitsData << 8 | nextByte).toString(16));
        }
      }
      bitsCount = 7;
      return bitsData >>> 7;
    }
    function decodeHuffman(tree) {
      var node = tree;
      while (true) {
        node = node[readBit()];
        if (typeof node === 'number') {
          return node;
        }
        if (typeof node !== 'object') {
          error('JPEG error: invalid huffman sequence');
        }
      }
    }
    function receive(length) {
      var n = 0;
      while (length > 0) {
        n = n << 1 | readBit();
        length--;
      }
      return n;
    }
    function receiveAndExtend(length) {
      if (length === 1) {
        return readBit() === 1 ? 1 : -1;
      }
      var n = receive(length);
      if (n >= 1 << length - 1) {
        return n;
      }
      return n + (-1 << length) + 1;
    }
    function decodeBaseline(component, offset) {
      var t = decodeHuffman(component.huffmanTableDC);
      var diff = t === 0 ? 0 : receiveAndExtend(t);
      component.blockData[offset] = component.pred += diff;
      var k = 1;
      while (k < 64) {
        var rs = decodeHuffman(component.huffmanTableAC);
        var s = rs & 15,
            r = rs >> 4;
        if (s === 0) {
          if (r < 15) {
            break;
          }
          k += 16;
          continue;
        }
        k += r;
        var z = dctZigZag[k];
        component.blockData[offset + z] = receiveAndExtend(s);
        k++;
      }
    }
    function decodeDCFirst(component, offset) {
      var t = decodeHuffman(component.huffmanTableDC);
      var diff = t === 0 ? 0 : receiveAndExtend(t) << successive;
      component.blockData[offset] = component.pred += diff;
    }
    function decodeDCSuccessive(component, offset) {
      component.blockData[offset] |= readBit() << successive;
    }
    var eobrun = 0;
    function decodeACFirst(component, offset) {
      if (eobrun > 0) {
        eobrun--;
        return;
      }
      var k = spectralStart,
          e = spectralEnd;
      while (k <= e) {
        var rs = decodeHuffman(component.huffmanTableAC);
        var s = rs & 15,
            r = rs >> 4;
        if (s === 0) {
          if (r < 15) {
            eobrun = receive(r) + (1 << r) - 1;
            break;
          }
          k += 16;
          continue;
        }
        k += r;
        var z = dctZigZag[k];
        component.blockData[offset + z] = receiveAndExtend(s) * (1 << successive);
        k++;
      }
    }
    var successiveACState = 0,
        successiveACNextValue;
    function decodeACSuccessive(component, offset) {
      var k = spectralStart;
      var e = spectralEnd;
      var r = 0;
      var s;
      var rs;
      while (k <= e) {
        var z = dctZigZag[k];
        switch (successiveACState) {
          case 0:
            rs = decodeHuffman(component.huffmanTableAC);
            s = rs & 15;
            r = rs >> 4;
            if (s === 0) {
              if (r < 15) {
                eobrun = receive(r) + (1 << r);
                successiveACState = 4;
              } else {
                r = 16;
                successiveACState = 1;
              }
            } else {
              if (s !== 1) {
                error('JPEG error: invalid ACn encoding');
              }
              successiveACNextValue = receiveAndExtend(s);
              successiveACState = r ? 2 : 3;
            }
            continue;
          case 1:
          case 2:
            if (component.blockData[offset + z]) {
              component.blockData[offset + z] += readBit() << successive;
            } else {
              r--;
              if (r === 0) {
                successiveACState = successiveACState === 2 ? 3 : 0;
              }
            }
            break;
          case 3:
            if (component.blockData[offset + z]) {
              component.blockData[offset + z] += readBit() << successive;
            } else {
              component.blockData[offset + z] = successiveACNextValue << successive;
              successiveACState = 0;
            }
            break;
          case 4:
            if (component.blockData[offset + z]) {
              component.blockData[offset + z] += readBit() << successive;
            }
            break;
        }
        k++;
      }
      if (successiveACState === 4) {
        eobrun--;
        if (eobrun === 0) {
          successiveACState = 0;
        }
      }
    }
    function decodeMcu(component, decode, mcu, row, col) {
      var mcuRow = mcu / mcusPerLine | 0;
      var mcuCol = mcu % mcusPerLine;
      var blockRow = mcuRow * component.v + row;
      var blockCol = mcuCol * component.h + col;
      var offset = getBlockBufferOffset(component, blockRow, blockCol);
      decode(component, offset);
    }
    function decodeBlock(component, decode, mcu) {
      var blockRow = mcu / component.blocksPerLine | 0;
      var blockCol = mcu % component.blocksPerLine;
      var offset = getBlockBufferOffset(component, blockRow, blockCol);
      decode(component, offset);
    }
    var componentsLength = components.length;
    var component, i, j, k, n;
    var decodeFn;
    if (progressive) {
      if (spectralStart === 0) {
        decodeFn = successivePrev === 0 ? decodeDCFirst : decodeDCSuccessive;
      } else {
        decodeFn = successivePrev === 0 ? decodeACFirst : decodeACSuccessive;
      }
    } else {
      decodeFn = decodeBaseline;
    }
    var mcu = 0,
        fileMarker;
    var mcuExpected;
    if (componentsLength === 1) {
      mcuExpected = components[0].blocksPerLine * components[0].blocksPerColumn;
    } else {
      mcuExpected = mcusPerLine * frame.mcusPerColumn;
    }
    var h, v;
    while (mcu < mcuExpected) {
      var mcuToRead = resetInterval ? Math.min(mcuExpected - mcu, resetInterval) : mcuExpected;
      for (i = 0; i < componentsLength; i++) {
        components[i].pred = 0;
      }
      eobrun = 0;
      if (componentsLength === 1) {
        component = components[0];
        for (n = 0; n < mcuToRead; n++) {
          decodeBlock(component, decodeFn, mcu);
          mcu++;
        }
      } else {
        for (n = 0; n < mcuToRead; n++) {
          for (i = 0; i < componentsLength; i++) {
            component = components[i];
            h = component.h;
            v = component.v;
            for (j = 0; j < v; j++) {
              for (k = 0; k < h; k++) {
                decodeMcu(component, decodeFn, mcu, j, k);
              }
            }
          }
          mcu++;
        }
      }
      bitsCount = 0;
      fileMarker = findNextFileMarker(data, offset);
      if (fileMarker && fileMarker.invalid) {
        warn('decodeScan - unexpected MCU data, next marker is: ' + fileMarker.invalid);
        offset = fileMarker.offset;
      }
      var marker = fileMarker && fileMarker.marker;
      if (!marker || marker <= 0xFF00) {
        error('JPEG error: marker was not found');
      }
      if (marker >= 0xFFD0 && marker <= 0xFFD7) {
        offset += 2;
      } else {
        break;
      }
    }
    fileMarker = findNextFileMarker(data, offset);
    if (fileMarker && fileMarker.invalid) {
      warn('decodeScan - unexpected Scan data, next marker is: ' + fileMarker.invalid);
      offset = fileMarker.offset;
    }
    return offset - startOffset;
  }
  function quantizeAndInverse(component, blockBufferOffset, p) {
    var qt = component.quantizationTable,
        blockData = component.blockData;
    var v0, v1, v2, v3, v4, v5, v6, v7;
    var p0, p1, p2, p3, p4, p5, p6, p7;
    var t;
    if (!qt) {
      error('JPEG error: missing required Quantization Table.');
    }
    for (var row = 0; row < 64; row += 8) {
      p0 = blockData[blockBufferOffset + row];
      p1 = blockData[blockBufferOffset + row + 1];
      p2 = blockData[blockBufferOffset + row + 2];
      p3 = blockData[blockBufferOffset + row + 3];
      p4 = blockData[blockBufferOffset + row + 4];
      p5 = blockData[blockBufferOffset + row + 5];
      p6 = blockData[blockBufferOffset + row + 6];
      p7 = blockData[blockBufferOffset + row + 7];
      p0 *= qt[row];
      if ((p1 | p2 | p3 | p4 | p5 | p6 | p7) === 0) {
        t = dctSqrt2 * p0 + 512 >> 10;
        p[row] = t;
        p[row + 1] = t;
        p[row + 2] = t;
        p[row + 3] = t;
        p[row + 4] = t;
        p[row + 5] = t;
        p[row + 6] = t;
        p[row + 7] = t;
        continue;
      }
      p1 *= qt[row + 1];
      p2 *= qt[row + 2];
      p3 *= qt[row + 3];
      p4 *= qt[row + 4];
      p5 *= qt[row + 5];
      p6 *= qt[row + 6];
      p7 *= qt[row + 7];
      v0 = dctSqrt2 * p0 + 128 >> 8;
      v1 = dctSqrt2 * p4 + 128 >> 8;
      v2 = p2;
      v3 = p6;
      v4 = dctSqrt1d2 * (p1 - p7) + 128 >> 8;
      v7 = dctSqrt1d2 * (p1 + p7) + 128 >> 8;
      v5 = p3 << 4;
      v6 = p5 << 4;
      v0 = v0 + v1 + 1 >> 1;
      v1 = v0 - v1;
      t = v2 * dctSin6 + v3 * dctCos6 + 128 >> 8;
      v2 = v2 * dctCos6 - v3 * dctSin6 + 128 >> 8;
      v3 = t;
      v4 = v4 + v6 + 1 >> 1;
      v6 = v4 - v6;
      v7 = v7 + v5 + 1 >> 1;
      v5 = v7 - v5;
      v0 = v0 + v3 + 1 >> 1;
      v3 = v0 - v3;
      v1 = v1 + v2 + 1 >> 1;
      v2 = v1 - v2;
      t = v4 * dctSin3 + v7 * dctCos3 + 2048 >> 12;
      v4 = v4 * dctCos3 - v7 * dctSin3 + 2048 >> 12;
      v7 = t;
      t = v5 * dctSin1 + v6 * dctCos1 + 2048 >> 12;
      v5 = v5 * dctCos1 - v6 * dctSin1 + 2048 >> 12;
      v6 = t;
      p[row] = v0 + v7;
      p[row + 7] = v0 - v7;
      p[row + 1] = v1 + v6;
      p[row + 6] = v1 - v6;
      p[row + 2] = v2 + v5;
      p[row + 5] = v2 - v5;
      p[row + 3] = v3 + v4;
      p[row + 4] = v3 - v4;
    }
    for (var col = 0; col < 8; ++col) {
      p0 = p[col];
      p1 = p[col + 8];
      p2 = p[col + 16];
      p3 = p[col + 24];
      p4 = p[col + 32];
      p5 = p[col + 40];
      p6 = p[col + 48];
      p7 = p[col + 56];
      if ((p1 | p2 | p3 | p4 | p5 | p6 | p7) === 0) {
        t = dctSqrt2 * p0 + 8192 >> 14;
        t = t < -2040 ? 0 : t >= 2024 ? 255 : t + 2056 >> 4;
        blockData[blockBufferOffset + col] = t;
        blockData[blockBufferOffset + col + 8] = t;
        blockData[blockBufferOffset + col + 16] = t;
        blockData[blockBufferOffset + col + 24] = t;
        blockData[blockBufferOffset + col + 32] = t;
        blockData[blockBufferOffset + col + 40] = t;
        blockData[blockBufferOffset + col + 48] = t;
        blockData[blockBufferOffset + col + 56] = t;
        continue;
      }
      v0 = dctSqrt2 * p0 + 2048 >> 12;
      v1 = dctSqrt2 * p4 + 2048 >> 12;
      v2 = p2;
      v3 = p6;
      v4 = dctSqrt1d2 * (p1 - p7) + 2048 >> 12;
      v7 = dctSqrt1d2 * (p1 + p7) + 2048 >> 12;
      v5 = p3;
      v6 = p5;
      v0 = (v0 + v1 + 1 >> 1) + 4112;
      v1 = v0 - v1;
      t = v2 * dctSin6 + v3 * dctCos6 + 2048 >> 12;
      v2 = v2 * dctCos6 - v3 * dctSin6 + 2048 >> 12;
      v3 = t;
      v4 = v4 + v6 + 1 >> 1;
      v6 = v4 - v6;
      v7 = v7 + v5 + 1 >> 1;
      v5 = v7 - v5;
      v0 = v0 + v3 + 1 >> 1;
      v3 = v0 - v3;
      v1 = v1 + v2 + 1 >> 1;
      v2 = v1 - v2;
      t = v4 * dctSin3 + v7 * dctCos3 + 2048 >> 12;
      v4 = v4 * dctCos3 - v7 * dctSin3 + 2048 >> 12;
      v7 = t;
      t = v5 * dctSin1 + v6 * dctCos1 + 2048 >> 12;
      v5 = v5 * dctCos1 - v6 * dctSin1 + 2048 >> 12;
      v6 = t;
      p0 = v0 + v7;
      p7 = v0 - v7;
      p1 = v1 + v6;
      p6 = v1 - v6;
      p2 = v2 + v5;
      p5 = v2 - v5;
      p3 = v3 + v4;
      p4 = v3 - v4;
      p0 = p0 < 16 ? 0 : p0 >= 4080 ? 255 : p0 >> 4;
      p1 = p1 < 16 ? 0 : p1 >= 4080 ? 255 : p1 >> 4;
      p2 = p2 < 16 ? 0 : p2 >= 4080 ? 255 : p2 >> 4;
      p3 = p3 < 16 ? 0 : p3 >= 4080 ? 255 : p3 >> 4;
      p4 = p4 < 16 ? 0 : p4 >= 4080 ? 255 : p4 >> 4;
      p5 = p5 < 16 ? 0 : p5 >= 4080 ? 255 : p5 >> 4;
      p6 = p6 < 16 ? 0 : p6 >= 4080 ? 255 : p6 >> 4;
      p7 = p7 < 16 ? 0 : p7 >= 4080 ? 255 : p7 >> 4;
      blockData[blockBufferOffset + col] = p0;
      blockData[blockBufferOffset + col + 8] = p1;
      blockData[blockBufferOffset + col + 16] = p2;
      blockData[blockBufferOffset + col + 24] = p3;
      blockData[blockBufferOffset + col + 32] = p4;
      blockData[blockBufferOffset + col + 40] = p5;
      blockData[blockBufferOffset + col + 48] = p6;
      blockData[blockBufferOffset + col + 56] = p7;
    }
  }
  function buildComponentData(frame, component) {
    var blocksPerLine = component.blocksPerLine;
    var blocksPerColumn = component.blocksPerColumn;
    var computationBuffer = new Int16Array(64);
    for (var blockRow = 0; blockRow < blocksPerColumn; blockRow++) {
      for (var blockCol = 0; blockCol < blocksPerLine; blockCol++) {
        var offset = getBlockBufferOffset(component, blockRow, blockCol);
        quantizeAndInverse(component, offset, computationBuffer);
      }
    }
    return component.blockData;
  }
  function clamp0to255(a) {
    return a <= 0 ? 0 : a >= 255 ? 255 : a;
  }
  function findNextFileMarker(data, currentPos, startPos) {
    function peekUint16(pos) {
      return data[pos] << 8 | data[pos + 1];
    }
    var maxPos = data.length - 1;
    var newPos = startPos < currentPos ? startPos : currentPos;
    if (currentPos >= maxPos) {
      return null;
    }
    var currentMarker = peekUint16(currentPos);
    if (currentMarker >= 0xFFC0 && currentMarker <= 0xFFFE) {
      return {
        invalid: null,
        marker: currentMarker,
        offset: currentPos
      };
    }
    var newMarker = peekUint16(newPos);
    while (!(newMarker >= 0xFFC0 && newMarker <= 0xFFFE)) {
      if (++newPos >= maxPos) {
        return null;
      }
      newMarker = peekUint16(newPos);
    }
    return {
      invalid: currentMarker.toString(16),
      marker: newMarker,
      offset: newPos
    };
  }
  JpegImage.prototype = {
    parse: function parse(data) {
      function readUint16() {
        var value = data[offset] << 8 | data[offset + 1];
        offset += 2;
        return value;
      }
      function readDataBlock() {
        var length = readUint16();
        var endOffset = offset + length - 2;
        var fileMarker = findNextFileMarker(data, endOffset, offset);
        if (fileMarker && fileMarker.invalid) {
          warn('readDataBlock - incorrect length, next marker is: ' + fileMarker.invalid);
          endOffset = fileMarker.offset;
        }
        var array = data.subarray(offset, endOffset);
        offset += array.length;
        return array;
      }
      function prepareComponents(frame) {
        var mcusPerLine = Math.ceil(frame.samplesPerLine / 8 / frame.maxH);
        var mcusPerColumn = Math.ceil(frame.scanLines / 8 / frame.maxV);
        for (var i = 0; i < frame.components.length; i++) {
          component = frame.components[i];
          var blocksPerLine = Math.ceil(Math.ceil(frame.samplesPerLine / 8) * component.h / frame.maxH);
          var blocksPerColumn = Math.ceil(Math.ceil(frame.scanLines / 8) * component.v / frame.maxV);
          var blocksPerLineForMcu = mcusPerLine * component.h;
          var blocksPerColumnForMcu = mcusPerColumn * component.v;
          var blocksBufferSize = 64 * blocksPerColumnForMcu * (blocksPerLineForMcu + 1);
          component.blockData = new Int16Array(blocksBufferSize);
          component.blocksPerLine = blocksPerLine;
          component.blocksPerColumn = blocksPerColumn;
        }
        frame.mcusPerLine = mcusPerLine;
        frame.mcusPerColumn = mcusPerColumn;
      }
      var offset = 0;
      var jfif = null;
      var adobe = null;
      var frame, resetInterval;
      var quantizationTables = [];
      var huffmanTablesAC = [],
          huffmanTablesDC = [];
      var fileMarker = readUint16();
      if (fileMarker !== 0xFFD8) {
        error('JPEG error: SOI not found');
      }
      fileMarker = readUint16();
      while (fileMarker !== 0xFFD9) {
        var i, j, l;
        switch (fileMarker) {
          case 0xFFE0:
          case 0xFFE1:
          case 0xFFE2:
          case 0xFFE3:
          case 0xFFE4:
          case 0xFFE5:
          case 0xFFE6:
          case 0xFFE7:
          case 0xFFE8:
          case 0xFFE9:
          case 0xFFEA:
          case 0xFFEB:
          case 0xFFEC:
          case 0xFFED:
          case 0xFFEE:
          case 0xFFEF:
          case 0xFFFE:
            var appData = readDataBlock();
            if (fileMarker === 0xFFE0) {
              if (appData[0] === 0x4A && appData[1] === 0x46 && appData[2] === 0x49 && appData[3] === 0x46 && appData[4] === 0) {
                jfif = {
                  version: {
                    major: appData[5],
                    minor: appData[6]
                  },
                  densityUnits: appData[7],
                  xDensity: appData[8] << 8 | appData[9],
                  yDensity: appData[10] << 8 | appData[11],
                  thumbWidth: appData[12],
                  thumbHeight: appData[13],
                  thumbData: appData.subarray(14, 14 + 3 * appData[12] * appData[13])
                };
              }
            }
            if (fileMarker === 0xFFEE) {
              if (appData[0] === 0x41 && appData[1] === 0x64 && appData[2] === 0x6F && appData[3] === 0x62 && appData[4] === 0x65) {
                adobe = {
                  version: appData[5] << 8 | appData[6],
                  flags0: appData[7] << 8 | appData[8],
                  flags1: appData[9] << 8 | appData[10],
                  transformCode: appData[11]
                };
              }
            }
            break;
          case 0xFFDB:
            var quantizationTablesLength = readUint16();
            var quantizationTablesEnd = quantizationTablesLength + offset - 2;
            var z;
            while (offset < quantizationTablesEnd) {
              var quantizationTableSpec = data[offset++];
              var tableData = new Uint16Array(64);
              if (quantizationTableSpec >> 4 === 0) {
                for (j = 0; j < 64; j++) {
                  z = dctZigZag[j];
                  tableData[z] = data[offset++];
                }
              } else if (quantizationTableSpec >> 4 === 1) {
                for (j = 0; j < 64; j++) {
                  z = dctZigZag[j];
                  tableData[z] = readUint16();
                }
              } else {
                error('JPEG error: DQT - invalid table spec');
              }
              quantizationTables[quantizationTableSpec & 15] = tableData;
            }
            break;
          case 0xFFC0:
          case 0xFFC1:
          case 0xFFC2:
            if (frame) {
              error('JPEG error: Only single frame JPEGs supported');
            }
            readUint16();
            frame = {};
            frame.extended = fileMarker === 0xFFC1;
            frame.progressive = fileMarker === 0xFFC2;
            frame.precision = data[offset++];
            frame.scanLines = readUint16();
            frame.samplesPerLine = readUint16();
            frame.components = [];
            frame.componentIds = {};
            var componentsCount = data[offset++],
                componentId;
            var maxH = 0,
                maxV = 0;
            for (i = 0; i < componentsCount; i++) {
              componentId = data[offset];
              var h = data[offset + 1] >> 4;
              var v = data[offset + 1] & 15;
              if (maxH < h) {
                maxH = h;
              }
              if (maxV < v) {
                maxV = v;
              }
              var qId = data[offset + 2];
              l = frame.components.push({
                h: h,
                v: v,
                quantizationId: qId,
                quantizationTable: null
              });
              frame.componentIds[componentId] = l - 1;
              offset += 3;
            }
            frame.maxH = maxH;
            frame.maxV = maxV;
            prepareComponents(frame);
            break;
          case 0xFFC4:
            var huffmanLength = readUint16();
            for (i = 2; i < huffmanLength;) {
              var huffmanTableSpec = data[offset++];
              var codeLengths = new Uint8Array(16);
              var codeLengthSum = 0;
              for (j = 0; j < 16; j++, offset++) {
                codeLengthSum += codeLengths[j] = data[offset];
              }
              var huffmanValues = new Uint8Array(codeLengthSum);
              for (j = 0; j < codeLengthSum; j++, offset++) {
                huffmanValues[j] = data[offset];
              }
              i += 17 + codeLengthSum;
              (huffmanTableSpec >> 4 === 0 ? huffmanTablesDC : huffmanTablesAC)[huffmanTableSpec & 15] = buildHuffmanTable(codeLengths, huffmanValues);
            }
            break;
          case 0xFFDD:
            readUint16();
            resetInterval = readUint16();
            break;
          case 0xFFDA:
            readUint16();
            var selectorsCount = data[offset++];
            var components = [],
                component;
            for (i = 0; i < selectorsCount; i++) {
              var componentIndex = frame.componentIds[data[offset++]];
              component = frame.components[componentIndex];
              var tableSpec = data[offset++];
              component.huffmanTableDC = huffmanTablesDC[tableSpec >> 4];
              component.huffmanTableAC = huffmanTablesAC[tableSpec & 15];
              components.push(component);
            }
            var spectralStart = data[offset++];
            var spectralEnd = data[offset++];
            var successiveApproximation = data[offset++];
            var processed = decodeScan(data, offset, frame, components, resetInterval, spectralStart, spectralEnd, successiveApproximation >> 4, successiveApproximation & 15);
            offset += processed;
            break;
          case 0xFFFF:
            if (data[offset] !== 0xFF) {
              offset--;
            }
            break;
          default:
            if (data[offset - 3] === 0xFF && data[offset - 2] >= 0xC0 && data[offset - 2] <= 0xFE) {
              offset -= 3;
              break;
            }
            error('JPEG error: unknown marker ' + fileMarker.toString(16));
        }
        fileMarker = readUint16();
      }
      this.width = frame.samplesPerLine;
      this.height = frame.scanLines;
      this.jfif = jfif;
      this.adobe = adobe;
      this.components = [];
      for (i = 0; i < frame.components.length; i++) {
        component = frame.components[i];
        var quantizationTable = quantizationTables[component.quantizationId];
        if (quantizationTable) {
          component.quantizationTable = quantizationTable;
        }
        this.components.push({
          output: buildComponentData(frame, component),
          scaleX: component.h / frame.maxH,
          scaleY: component.v / frame.maxV,
          blocksPerLine: component.blocksPerLine,
          blocksPerColumn: component.blocksPerColumn
        });
      }
      this.numComponents = this.components.length;
    },
    _getLinearizedBlockData: function getLinearizedBlockData(width, height) {
      var scaleX = this.width / width,
          scaleY = this.height / height;
      var component, componentScaleX, componentScaleY, blocksPerScanline;
      var x, y, i, j, k;
      var index;
      var offset = 0;
      var output;
      var numComponents = this.components.length;
      var dataLength = width * height * numComponents;
      var data = new Uint8Array(dataLength);
      var xScaleBlockOffset = new Uint32Array(width);
      var mask3LSB = 0xfffffff8;
      for (i = 0; i < numComponents; i++) {
        component = this.components[i];
        componentScaleX = component.scaleX * scaleX;
        componentScaleY = component.scaleY * scaleY;
        offset = i;
        output = component.output;
        blocksPerScanline = component.blocksPerLine + 1 << 3;
        for (x = 0; x < width; x++) {
          j = 0 | x * componentScaleX;
          xScaleBlockOffset[x] = (j & mask3LSB) << 3 | j & 7;
        }
        for (y = 0; y < height; y++) {
          j = 0 | y * componentScaleY;
          index = blocksPerScanline * (j & mask3LSB) | (j & 7) << 3;
          for (x = 0; x < width; x++) {
            data[offset] = output[index + xScaleBlockOffset[x]];
            offset += numComponents;
          }
        }
      }
      var transform = this.decodeTransform;
      if (transform) {
        for (i = 0; i < dataLength;) {
          for (j = 0, k = 0; j < numComponents; j++, i++, k += 2) {
            data[i] = (data[i] * transform[k] >> 8) + transform[k + 1];
          }
        }
      }
      return data;
    },
    _isColorConversionNeeded: function isColorConversionNeeded() {
      if (this.adobe && this.adobe.transformCode) {
        return true;
      } else if (this.numComponents === 3) {
        if (!this.adobe && this.colorTransform === 0) {
          return false;
        }
        return true;
      }
      if (!this.adobe && this.colorTransform === 1) {
        return true;
      }
      return false;
    },
    _convertYccToRgb: function convertYccToRgb(data) {
      var Y, Cb, Cr;
      for (var i = 0, length = data.length; i < length; i += 3) {
        Y = data[i];
        Cb = data[i + 1];
        Cr = data[i + 2];
        data[i] = clamp0to255(Y - 179.456 + 1.402 * Cr);
        data[i + 1] = clamp0to255(Y + 135.459 - 0.344 * Cb - 0.714 * Cr);
        data[i + 2] = clamp0to255(Y - 226.816 + 1.772 * Cb);
      }
      return data;
    },
    _convertYcckToRgb: function convertYcckToRgb(data) {
      var Y, Cb, Cr, k;
      var offset = 0;
      for (var i = 0, length = data.length; i < length; i += 4) {
        Y = 255-data[i];
        Cb = 255-data[i + 1];
        Cr = 255-data[i + 2];
        k = 255-data[i + 3];
        var r = -122.67195406894 + Cb * (-6.60635669420364e-5 * Cb + 0.000437130475926232 * Cr - 5.4080610064599e-5 * Y + 0.00048449797120281 * k - 0.154362151871126) + Cr * (-0.000957964378445773 * Cr + 0.000817076911346625 * Y - 0.00477271405408747 * k + 1.53380253221734) + Y * (0.000961250184130688 * Y - 0.00266257332283933 * k + 0.48357088451265) + k * (-0.000336197177618394 * k + 0.484791561490776);
        var g = 107.268039397724 + Cb * (2.19927104525741e-5 * Cb - 0.000640992018297945 * Cr + 0.000659397001245577 * Y + 0.000426105652938837 * k - 0.176491792462875) + Cr * (-0.000778269941513683 * Cr + 0.00130872261408275 * Y + 0.000770482631801132 * k - 0.151051492775562) + Y * (0.00126935368114843 * Y - 0.00265090189010898 * k + 0.25802910206845) + k * (-0.000318913117588328 * k - 0.213742400323665);
        var b = -20.810012546947 + Cb * (-0.000570115196973677 * Cb - 2.63409051004589e-5 * Cr + 0.0020741088115012 * Y - 0.00288260236853442 * k + 0.814272968359295) + Cr * (-1.53496057440975e-5 * Cr - 0.000132689043961446 * Y + 0.000560833691242812 * k - 0.195152027534049) + Y * (0.00174418132927582 * Y - 0.00255243321439347 * k + 0.116935020465145) + k * (-0.000343531996510555 * k + 0.24165260232407);
        data[offset++] = clamp0to255(r);
        data[offset++] = clamp0to255(g);
        data[offset++] = clamp0to255(b);
      }
      return data;
    },
    _convertYcckToCmyk: function convertYcckToCmyk(data) {
      var Y, Cb, Cr;
      for (var i = 0, length = data.length; i < length; i += 4) {
        Y = data[i];
        Cb = data[i + 1];
        Cr = data[i + 2];
        data[i] = clamp0to255(434.456 - Y - 1.402 * Cr);
        data[i + 1] = clamp0to255(119.541 - Y + 0.344 * Cb + 0.714 * Cr);
        data[i + 2] = clamp0to255(481.816 - Y - 1.772 * Cb);
      }
      return data;
    },
    _convertCmykToRgb: function convertCmykToRgb(data) {
      var c, m, y, k;
      var offset = 0;
      var min = -255 * 255 * 255;
      var scale = 1 / 255 / 255;
      for (var i = 0, length = data.length; i < length; i += 4) {
        c = 255-data[i];
        m = 255-data[i + 1];
        y = 255-data[i + 2];
        k = 255-data[i + 3];
        var r = c * (-4.387332384609988 * c + 54.48615194189176 * m + 18.82290502165302 * y + 212.25662451639585 * k - 72734.4411664936) + m * (1.7149763477362134 * m - 5.6096736904047315 * y - 17.873870861415444 * k - 1401.7366389350734) + y * (-2.5217340131683033 * y - 21.248923337353073 * k + 4465.541406466231) - k * (21.86122147463605 * k + 48317.86113160301);
        var g = c * (8.841041422036149 * c + 60.118027045597366 * m + 6.871425592049007 * y + 31.159100130055922 * k - 20220.756542821975) + m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k - 48691.05921601825) + y * (4.444339102852739 * y + 9.8632861493405 * k - 6341.191035517494) - k * (20.737325471181034 * k + 47890.15695978492);
        var b = c * (0.8842522430003296 * c + 8.078677503112928 * m + 30.89978309703729 * y - 0.23883238689178934 * k - 3616.812083916688) + m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k - 28620.90484698408) + y * (0.03296041114873217 * y + 115.60384449646641 * k - 49363.43385999684) - k * (22.33816807309886 * k + 45932.16563550634);
        data[offset++] = r >= 0 ? 255 : r <= min ? 0 : 255 + r * scale | 0;
        data[offset++] = g >= 0 ? 255 : g <= min ? 0 : 255 + g * scale | 0;
        data[offset++] = b >= 0 ? 255 : b <= min ? 0 : 255 + b * scale | 0;
      }
      return data;
    },
    getData: function getData(width, height, forceRGBoutput) {
      if (this.numComponents > 4) {
        error('JPEG error: Unsupported color mode');
      }
      var data = this._getLinearizedBlockData(width, height);
      if (this.numComponents === 1 && forceRGBoutput) {
        var dataLength = data.length;
        var rgbData = new Uint8Array(dataLength * 3);
        var offset = 0;
        for (var i = 0; i < dataLength; i++) {
          var grayColor = data[i];
          rgbData[offset++] = grayColor;
          rgbData[offset++] = grayColor;
          rgbData[offset++] = grayColor;
        }
        return rgbData;
      } else if (this.numComponents === 3 && this._isColorConversionNeeded()) {
        return this._convertYccToRgb(data);
      } else if (this.numComponents === 4) {
        if (this._isColorConversionNeeded()) {
          if (forceRGBoutput) {
            return this._convertYcckToRgb(data);
          }
          return this._convertYcckToCmyk(data);
        } else if (forceRGBoutput) {
          return this._convertCmykToRgb(data);
        }
      }
      return data;
    }
  };
  return JpegImage;
}();

	
	
	"use strict";
    var ArithmeticDecoder = function ArithmeticDecoderClosure() {
  var QeTable = [{
    qe: 0x5601,
    nmps: 1,
    nlps: 1,
    switchFlag: 1
  }, {
    qe: 0x3401,
    nmps: 2,
    nlps: 6,
    switchFlag: 0
  }, {
    qe: 0x1801,
    nmps: 3,
    nlps: 9,
    switchFlag: 0
  }, {
    qe: 0x0AC1,
    nmps: 4,
    nlps: 12,
    switchFlag: 0
  }, {
    qe: 0x0521,
    nmps: 5,
    nlps: 29,
    switchFlag: 0
  }, {
    qe: 0x0221,
    nmps: 38,
    nlps: 33,
    switchFlag: 0
  }, {
    qe: 0x5601,
    nmps: 7,
    nlps: 6,
    switchFlag: 1
  }, {
    qe: 0x5401,
    nmps: 8,
    nlps: 14,
    switchFlag: 0
  }, {
    qe: 0x4801,
    nmps: 9,
    nlps: 14,
    switchFlag: 0
  }, {
    qe: 0x3801,
    nmps: 10,
    nlps: 14,
    switchFlag: 0
  }, {
    qe: 0x3001,
    nmps: 11,
    nlps: 17,
    switchFlag: 0
  }, {
    qe: 0x2401,
    nmps: 12,
    nlps: 18,
    switchFlag: 0
  }, {
    qe: 0x1C01,
    nmps: 13,
    nlps: 20,
    switchFlag: 0
  }, {
    qe: 0x1601,
    nmps: 29,
    nlps: 21,
    switchFlag: 0
  }, {
    qe: 0x5601,
    nmps: 15,
    nlps: 14,
    switchFlag: 1
  }, {
    qe: 0x5401,
    nmps: 16,
    nlps: 14,
    switchFlag: 0
  }, {
    qe: 0x5101,
    nmps: 17,
    nlps: 15,
    switchFlag: 0
  }, {
    qe: 0x4801,
    nmps: 18,
    nlps: 16,
    switchFlag: 0
  }, {
    qe: 0x3801,
    nmps: 19,
    nlps: 17,
    switchFlag: 0
  }, {
    qe: 0x3401,
    nmps: 20,
    nlps: 18,
    switchFlag: 0
  }, {
    qe: 0x3001,
    nmps: 21,
    nlps: 19,
    switchFlag: 0
  }, {
    qe: 0x2801,
    nmps: 22,
    nlps: 19,
    switchFlag: 0
  }, {
    qe: 0x2401,
    nmps: 23,
    nlps: 20,
    switchFlag: 0
  }, {
    qe: 0x2201,
    nmps: 24,
    nlps: 21,
    switchFlag: 0
  }, {
    qe: 0x1C01,
    nmps: 25,
    nlps: 22,
    switchFlag: 0
  }, {
    qe: 0x1801,
    nmps: 26,
    nlps: 23,
    switchFlag: 0
  }, {
    qe: 0x1601,
    nmps: 27,
    nlps: 24,
    switchFlag: 0
  }, {
    qe: 0x1401,
    nmps: 28,
    nlps: 25,
    switchFlag: 0
  }, {
    qe: 0x1201,
    nmps: 29,
    nlps: 26,
    switchFlag: 0
  }, {
    qe: 0x1101,
    nmps: 30,
    nlps: 27,
    switchFlag: 0
  }, {
    qe: 0x0AC1,
    nmps: 31,
    nlps: 28,
    switchFlag: 0
  }, {
    qe: 0x09C1,
    nmps: 32,
    nlps: 29,
    switchFlag: 0
  }, {
    qe: 0x08A1,
    nmps: 33,
    nlps: 30,
    switchFlag: 0
  }, {
    qe: 0x0521,
    nmps: 34,
    nlps: 31,
    switchFlag: 0
  }, {
    qe: 0x0441,
    nmps: 35,
    nlps: 32,
    switchFlag: 0
  }, {
    qe: 0x02A1,
    nmps: 36,
    nlps: 33,
    switchFlag: 0
  }, {
    qe: 0x0221,
    nmps: 37,
    nlps: 34,
    switchFlag: 0
  }, {
    qe: 0x0141,
    nmps: 38,
    nlps: 35,
    switchFlag: 0
  }, {
    qe: 0x0111,
    nmps: 39,
    nlps: 36,
    switchFlag: 0
  }, {
    qe: 0x0085,
    nmps: 40,
    nlps: 37,
    switchFlag: 0
  }, {
    qe: 0x0049,
    nmps: 41,
    nlps: 38,
    switchFlag: 0
  }, {
    qe: 0x0025,
    nmps: 42,
    nlps: 39,
    switchFlag: 0
  }, {
    qe: 0x0015,
    nmps: 43,
    nlps: 40,
    switchFlag: 0
  }, {
    qe: 0x0009,
    nmps: 44,
    nlps: 41,
    switchFlag: 0
  }, {
    qe: 0x0005,
    nmps: 45,
    nlps: 42,
    switchFlag: 0
  }, {
    qe: 0x0001,
    nmps: 45,
    nlps: 43,
    switchFlag: 0
  }, {
    qe: 0x5601,
    nmps: 46,
    nlps: 46,
    switchFlag: 0
  }];
  function ArithmeticDecoder(data, start, end) {
    this.data = data;
    this.bp = start;
    this.dataEnd = end;
    this.chigh = data[start];
    this.clow = 0;
    this.byteIn();
    this.chigh = this.chigh << 7 & 0xFFFF | this.clow >> 9 & 0x7F;
    this.clow = this.clow << 7 & 0xFFFF;
    this.ct -= 7;
    this.a = 0x8000;
  }
  ArithmeticDecoder.prototype = {
    byteIn: function ArithmeticDecoder_byteIn() {
      var data = this.data;
      var bp = this.bp;
      if (data[bp] === 0xFF) {
        var b1 = data[bp + 1];
        if (b1 > 0x8F) {
          this.clow += 0xFF00;
          this.ct = 8;
        } else {
          bp++;
          this.clow += data[bp] << 9;
          this.ct = 7;
          this.bp = bp;
        }
      } else {
        bp++;
        this.clow += bp < this.dataEnd ? data[bp] << 8 : 0xFF00;
        this.ct = 8;
        this.bp = bp;
      }
      if (this.clow > 0xFFFF) {
        this.chigh += this.clow >> 16;
        this.clow &= 0xFFFF;
      }
    },
    readBit: function ArithmeticDecoder_readBit(contexts, pos) {
      var cx_index = contexts[pos] >> 1,
          cx_mps = contexts[pos] & 1;
      var qeTableIcx = QeTable[cx_index];
      var qeIcx = qeTableIcx.qe;
      var d;
      var a = this.a - qeIcx;
      if (this.chigh < qeIcx) {
        if (a < qeIcx) {
          a = qeIcx;
          d = cx_mps;
          cx_index = qeTableIcx.nmps;
        } else {
          a = qeIcx;
          d = 1 ^ cx_mps;
          if (qeTableIcx.switchFlag === 1) {
            cx_mps = d;
          }
          cx_index = qeTableIcx.nlps;
        }
      } else {
        this.chigh -= qeIcx;
        if ((a & 0x8000) !== 0) {
          this.a = a;
          return cx_mps;
        }
        if (a < qeIcx) {
          d = 1 ^ cx_mps;
          if (qeTableIcx.switchFlag === 1) {
            cx_mps = d;
          }
          cx_index = qeTableIcx.nlps;
        } else {
          d = cx_mps;
          cx_index = qeTableIcx.nmps;
        }
      }
      do {
        if (this.ct === 0) {
          this.byteIn();
        }
        a <<= 1;
        this.chigh = this.chigh << 1 & 0xFFFF | this.clow >> 15 & 1;
        this.clow = this.clow << 1 & 0xFFFF;
        this.ct--;
      } while ((a & 0x8000) === 0);
      this.a = a;
      contexts[pos] = cx_index << 1 | cx_mps;
      return d;
    }
  };
  return ArithmeticDecoder;
}();


	
	"use strict";
   var JpxImage = function JpxImageClosure() {
  var SubbandsGainLog2 = {
    'LL': 0,
    'LH': 1,
    'HL': 1,
    'HH': 2
  };
  function JpxImage() {
    this.failOnCorruptedImage = false;
  }
  JpxImage.prototype = {
    parse: function JpxImage_parse(data) {
      var head = readUint16(data, 0);
      if (head === 0xFF4F) {
        this.parseCodestream(data, 0, data.length);
        return;
      }
      var position = 0,
          length = data.length;
      while (position < length) {
        var headerSize = 8;
        var lbox = readUint32(data, position);
        var tbox = readUint32(data, position + 4);
        position += headerSize;
        if (lbox === 1) {
          lbox = readUint32(data, position) * 4294967296 + readUint32(data, position + 4);
          position += 8;
          headerSize += 8;
        }
        if (lbox === 0) {
          lbox = length - position + headerSize;
        }
        if (lbox < headerSize) {
          error('JPX Error: Invalid box field size');
        }
        var dataLength = lbox - headerSize;
        var jumpDataLength = true;
        switch (tbox) {
          case 0x6A703268:
            jumpDataLength = false;
            break;
          case 0x636F6C72:
            var method = data[position];
            if (method === 1) {
              var colorspace = readUint32(data, position + 3);
              switch (colorspace) {
                case 16:
                case 17:
                case 18:
                  break;
                default:
                  warn('Unknown colorspace ' + colorspace);
                  break;
              }
            } else if (method === 2) {
              info('ICC profile not supported');
            }
            break;
          case 0x6A703263:
            this.parseCodestream(data, position, position + dataLength);
            break;
          case 0x6A502020:
            if (readUint32(data, position) !== 0x0d0a870a) {
              warn('Invalid JP2 signature');
            }
            break;
          case 0x6A501A1A:
          case 0x66747970:
          case 0x72726571:
          case 0x72657320:
          case 0x69686472:
            break;
          default:
            var headerType = String.fromCharCode(tbox >> 24 & 0xFF, tbox >> 16 & 0xFF, tbox >> 8 & 0xFF, tbox & 0xFF);
            warn('Unsupported header type ' + tbox + ' (' + headerType + ')');
            break;
        }
        if (jumpDataLength) {
          position += dataLength;
        }
      }
    },
    parseImageProperties: function JpxImage_parseImageProperties(stream) {
      var newByte = stream.getByte();
      while (newByte >= 0) {
        var oldByte = newByte;
        newByte = stream.getByte();
        var code = oldByte << 8 | newByte;
        if (code === 0xFF51) {
          stream.skip(4);
          var Xsiz = stream.getInt32() >>> 0;
          var Ysiz = stream.getInt32() >>> 0;
          var XOsiz = stream.getInt32() >>> 0;
          var YOsiz = stream.getInt32() >>> 0;
          stream.skip(16);
          var Csiz = stream.getUint16();
          this.width = Xsiz - XOsiz;
          this.height = Ysiz - YOsiz;
          this.componentsCount = Csiz;
          this.bitsPerComponent = 8;
          return;
        }
      }
      error('JPX Error: No size marker found in JPX stream');
    },
    parseCodestream: function JpxImage_parseCodestream(data, start, end) {
      var context = {};
      var doNotRecover = false;
      try {
        var position = start;
        while (position + 1 < end) {
          var code = readUint16(data, position);
          position += 2;
          var length = 0,
              j,
              sqcd,
              spqcds,
              spqcdSize,
              scalarExpounded,
              tile;
          switch (code) {
            case 0xFF4F:
              context.mainHeader = true;
              break;
            case 0xFFD9:
              break;
            case 0xFF51:
              length = readUint16(data, position);
              var siz = {};
              siz.Xsiz = readUint32(data, position + 4);
              siz.Ysiz = readUint32(data, position + 8);
              siz.XOsiz = readUint32(data, position + 12);
              siz.YOsiz = readUint32(data, position + 16);
              siz.XTsiz = readUint32(data, position + 20);
              siz.YTsiz = readUint32(data, position + 24);
              siz.XTOsiz = readUint32(data, position + 28);
              siz.YTOsiz = readUint32(data, position + 32);
              var componentsCount = readUint16(data, position + 36);
              siz.Csiz = componentsCount;
              var components = [];
              j = position + 38;
              for (var i = 0; i < componentsCount; i++) {
                var component = {
                  precision: (data[j] & 0x7F) + 1,
                  isSigned: !!(data[j] & 0x80),
                  XRsiz: data[j + 1],
                  YRsiz: data[j + 1]
                };
                calculateComponentDimensions(component, siz);
                components.push(component);
              }
              context.SIZ = siz;
              context.components = components;
              calculateTileGrids(context, components);
              context.QCC = [];
              context.COC = [];
              break;
            case 0xFF5C:
              length = readUint16(data, position);
              var qcd = {};
              j = position + 2;
              sqcd = data[j++];
              switch (sqcd & 0x1F) {
                case 0:
                  spqcdSize = 8;
                  scalarExpounded = true;
                  break;
                case 1:
                  spqcdSize = 16;
                  scalarExpounded = false;
                  break;
                case 2:
                  spqcdSize = 16;
                  scalarExpounded = true;
                  break;
                default:
                  throw new Error('Invalid SQcd value ' + sqcd);
              }
              qcd.noQuantization = spqcdSize === 8;
              qcd.scalarExpounded = scalarExpounded;
              qcd.guardBits = sqcd >> 5;
              spqcds = [];
              while (j < length + position) {
                var spqcd = {};
                if (spqcdSize === 8) {
                  spqcd.epsilon = data[j++] >> 3;
                  spqcd.mu = 0;
                } else {
                  spqcd.epsilon = data[j] >> 3;
                  spqcd.mu = (data[j] & 0x7) << 8 | data[j + 1];
                  j += 2;
                }
                spqcds.push(spqcd);
              }
              qcd.SPqcds = spqcds;
              if (context.mainHeader) {
                context.QCD = qcd;
              } else {
                context.currentTile.QCD = qcd;
                context.currentTile.QCC = [];
              }
              break;
            case 0xFF5D:
              length = readUint16(data, position);
              var qcc = {};
              j = position + 2;
              var cqcc;
              if (context.SIZ.Csiz < 257) {
                cqcc = data[j++];
              } else {
                cqcc = readUint16(data, j);
                j += 2;
              }
              sqcd = data[j++];
              switch (sqcd & 0x1F) {
                case 0:
                  spqcdSize = 8;
                  scalarExpounded = true;
                  break;
                case 1:
                  spqcdSize = 16;
                  scalarExpounded = false;
                  break;
                case 2:
                  spqcdSize = 16;
                  scalarExpounded = true;
                  break;
                default:
                  throw new Error('Invalid SQcd value ' + sqcd);
              }
              qcc.noQuantization = spqcdSize === 8;
              qcc.scalarExpounded = scalarExpounded;
              qcc.guardBits = sqcd >> 5;
              spqcds = [];
              while (j < length + position) {
                spqcd = {};
                if (spqcdSize === 8) {
                  spqcd.epsilon = data[j++] >> 3;
                  spqcd.mu = 0;
                } else {
                  spqcd.epsilon = data[j] >> 3;
                  spqcd.mu = (data[j] & 0x7) << 8 | data[j + 1];
                  j += 2;
                }
                spqcds.push(spqcd);
              }
              qcc.SPqcds = spqcds;
              if (context.mainHeader) {
                context.QCC[cqcc] = qcc;
              } else {
                context.currentTile.QCC[cqcc] = qcc;
              }
              break;
            case 0xFF52:
              length = readUint16(data, position);
              var cod = {};
              j = position + 2;
              var scod = data[j++];
              cod.entropyCoderWithCustomPrecincts = !!(scod & 1);
              cod.sopMarkerUsed = !!(scod & 2);
              cod.ephMarkerUsed = !!(scod & 4);
              cod.progressionOrder = data[j++];
              cod.layersCount = readUint16(data, j);
              j += 2;
              cod.multipleComponentTransform = data[j++];
              cod.decompositionLevelsCount = data[j++];
              cod.xcb = (data[j++] & 0xF) + 2;
              cod.ycb = (data[j++] & 0xF) + 2;
              var blockStyle = data[j++];
              cod.selectiveArithmeticCodingBypass = !!(blockStyle & 1);
              cod.resetContextProbabilities = !!(blockStyle & 2);
              cod.terminationOnEachCodingPass = !!(blockStyle & 4);
              cod.verticalyStripe = !!(blockStyle & 8);
              cod.predictableTermination = !!(blockStyle & 16);
              cod.segmentationSymbolUsed = !!(blockStyle & 32);
              cod.reversibleTransformation = data[j++];
              if (cod.entropyCoderWithCustomPrecincts) {
                var precinctsSizes = [];
                while (j < length + position) {
                  var precinctsSize = data[j++];
                  precinctsSizes.push({
                    PPx: precinctsSize & 0xF,
                    PPy: precinctsSize >> 4
                  });
                }
                cod.precinctsSizes = precinctsSizes;
              }
              var unsupported = [];
              if (cod.selectiveArithmeticCodingBypass) {
                unsupported.push('selectiveArithmeticCodingBypass');
              }
              if (cod.resetContextProbabilities) {
                unsupported.push('resetContextProbabilities');
              }
              if (cod.terminationOnEachCodingPass) {
                unsupported.push('terminationOnEachCodingPass');
              }
              if (cod.verticalyStripe) {
                unsupported.push('verticalyStripe');
              }
              if (cod.predictableTermination) {
                unsupported.push('predictableTermination');
              }
              if (unsupported.length > 0) {
                doNotRecover = true;
                throw new Error('Unsupported COD options (' + unsupported.join(', ') + ')');
              }
              if (context.mainHeader) {
                context.COD = cod;
              } else {
                context.currentTile.COD = cod;
                context.currentTile.COC = [];
              }
              break;
            case 0xFF90:
              length = readUint16(data, position);
              tile = {};
              tile.index = readUint16(data, position + 2);
              tile.length = readUint32(data, position + 4);
              tile.dataEnd = tile.length + position - 2;
              tile.partIndex = data[position + 8];
              tile.partsCount = data[position + 9];
              context.mainHeader = false;
              if (tile.partIndex === 0) {
                tile.COD = context.COD;
                tile.COC = context.COC.slice(0);
                tile.QCD = context.QCD;
                tile.QCC = context.QCC.slice(0);
              }
              context.currentTile = tile;
              break;
            case 0xFF93:
              tile = context.currentTile;
              if (tile.partIndex === 0) {
                initializeTile(context, tile.index);
                buildPackets(context);
              }
              length = tile.dataEnd - position;
              parseTilePackets(context, data, position, length);
              break;
            case 0xFF55:
            case 0xFF57:
            case 0xFF58:
            case 0xFF64:
              length = readUint16(data, position);
              break;
            case 0xFF53:
              throw new Error('Codestream code 0xFF53 (COC) is ' + 'not implemented');
            default:
              throw new Error('Unknown codestream code: ' + code.toString(16));
          }
          position += length;
        }
      } catch (e) {
        if (doNotRecover || this.failOnCorruptedImage) {
          error('JPX Error: ' + e.message);
        } else {
          warn('JPX: Trying to recover from: ' + e.message);
        }
      }
      this.tiles = transformComponents(context);
      this.width = context.SIZ.Xsiz - context.SIZ.XOsiz;
      this.height = context.SIZ.Ysiz - context.SIZ.YOsiz;
      this.componentsCount = context.SIZ.Csiz;
    }
  };
  function calculateComponentDimensions(component, siz) {
    component.x0 = Math.ceil(siz.XOsiz / component.XRsiz);
    component.x1 = Math.ceil(siz.Xsiz / component.XRsiz);
    component.y0 = Math.ceil(siz.YOsiz / component.YRsiz);
    component.y1 = Math.ceil(siz.Ysiz / component.YRsiz);
    component.width = component.x1 - component.x0;
    component.height = component.y1 - component.y0;
  }
  function calculateTileGrids(context, components) {
    var siz = context.SIZ;
    var tile,
        tiles = [];
    var numXtiles = Math.ceil((siz.Xsiz - siz.XTOsiz) / siz.XTsiz);
    var numYtiles = Math.ceil((siz.Ysiz - siz.YTOsiz) / siz.YTsiz);
    for (var q = 0; q < numYtiles; q++) {
      for (var p = 0; p < numXtiles; p++) {
        tile = {};
        tile.tx0 = Math.max(siz.XTOsiz + p * siz.XTsiz, siz.XOsiz);
        tile.ty0 = Math.max(siz.YTOsiz + q * siz.YTsiz, siz.YOsiz);
        tile.tx1 = Math.min(siz.XTOsiz + (p + 1) * siz.XTsiz, siz.Xsiz);
        tile.ty1 = Math.min(siz.YTOsiz + (q + 1) * siz.YTsiz, siz.Ysiz);
        tile.width = tile.tx1 - tile.tx0;
        tile.height = tile.ty1 - tile.ty0;
        tile.components = [];
        tiles.push(tile);
      }
    }
    context.tiles = tiles;
    var componentsCount = siz.Csiz;
    for (var i = 0, ii = componentsCount; i < ii; i++) {
      var component = components[i];
      for (var j = 0, jj = tiles.length; j < jj; j++) {
        var tileComponent = {};
        tile = tiles[j];
        tileComponent.tcx0 = Math.ceil(tile.tx0 / component.XRsiz);
        tileComponent.tcy0 = Math.ceil(tile.ty0 / component.YRsiz);
        tileComponent.tcx1 = Math.ceil(tile.tx1 / component.XRsiz);
        tileComponent.tcy1 = Math.ceil(tile.ty1 / component.YRsiz);
        tileComponent.width = tileComponent.tcx1 - tileComponent.tcx0;
        tileComponent.height = tileComponent.tcy1 - tileComponent.tcy0;
        tile.components[i] = tileComponent;
      }
    }
  }
  function getBlocksDimensions(context, component, r) {
    var codOrCoc = component.codingStyleParameters;
    var result = {};
    if (!codOrCoc.entropyCoderWithCustomPrecincts) {
      result.PPx = 15;
      result.PPy = 15;
    } else {
      result.PPx = codOrCoc.precinctsSizes[r].PPx;
      result.PPy = codOrCoc.precinctsSizes[r].PPy;
    }
    result.xcb_ = r > 0 ? Math.min(codOrCoc.xcb, result.PPx - 1) : Math.min(codOrCoc.xcb, result.PPx);
    result.ycb_ = r > 0 ? Math.min(codOrCoc.ycb, result.PPy - 1) : Math.min(codOrCoc.ycb, result.PPy);
    return result;
  }
  function buildPrecincts(context, resolution, dimensions) {
    var precinctWidth = 1 << dimensions.PPx;
    var precinctHeight = 1 << dimensions.PPy;
    var isZeroRes = resolution.resLevel === 0;
    var precinctWidthInSubband = 1 << dimensions.PPx + (isZeroRes ? 0 : -1);
    var precinctHeightInSubband = 1 << dimensions.PPy + (isZeroRes ? 0 : -1);
    var numprecinctswide = resolution.trx1 > resolution.trx0 ? Math.ceil(resolution.trx1 / precinctWidth) - Math.floor(resolution.trx0 / precinctWidth) : 0;
    var numprecinctshigh = resolution.try1 > resolution.try0 ? Math.ceil(resolution.try1 / precinctHeight) - Math.floor(resolution.try0 / precinctHeight) : 0;
    var numprecincts = numprecinctswide * numprecinctshigh;
    resolution.precinctParameters = {
      precinctWidth: precinctWidth,
      precinctHeight: precinctHeight,
      numprecinctswide: numprecinctswide,
      numprecinctshigh: numprecinctshigh,
      numprecincts: numprecincts,
      precinctWidthInSubband: precinctWidthInSubband,
      precinctHeightInSubband: precinctHeightInSubband
    };
  }
  function buildCodeblocks(context, subband, dimensions) {
    var xcb_ = dimensions.xcb_;
    var ycb_ = dimensions.ycb_;
    var codeblockWidth = 1 << xcb_;
    var codeblockHeight = 1 << ycb_;
    var cbx0 = subband.tbx0 >> xcb_;
    var cby0 = subband.tby0 >> ycb_;
    var cbx1 = subband.tbx1 + codeblockWidth - 1 >> xcb_;
    var cby1 = subband.tby1 + codeblockHeight - 1 >> ycb_;
    var precinctParameters = subband.resolution.precinctParameters;
    var codeblocks = [];
    var precincts = [];
    var i, j, codeblock, precinctNumber;
    for (j = cby0; j < cby1; j++) {
      for (i = cbx0; i < cbx1; i++) {
        codeblock = {
          cbx: i,
          cby: j,
          tbx0: codeblockWidth * i,
          tby0: codeblockHeight * j,
          tbx1: codeblockWidth * (i + 1),
          tby1: codeblockHeight * (j + 1)
        };
        codeblock.tbx0_ = Math.max(subband.tbx0, codeblock.tbx0);
        codeblock.tby0_ = Math.max(subband.tby0, codeblock.tby0);
        codeblock.tbx1_ = Math.min(subband.tbx1, codeblock.tbx1);
        codeblock.tby1_ = Math.min(subband.tby1, codeblock.tby1);
        var pi = Math.floor((codeblock.tbx0_ - subband.tbx0) / precinctParameters.precinctWidthInSubband);
        var pj = Math.floor((codeblock.tby0_ - subband.tby0) / precinctParameters.precinctHeightInSubband);
        precinctNumber = pi + pj * precinctParameters.numprecinctswide;
        codeblock.precinctNumber = precinctNumber;
        codeblock.subbandType = subband.type;
        codeblock.Lblock = 3;
        if (codeblock.tbx1_ <= codeblock.tbx0_ || codeblock.tby1_ <= codeblock.tby0_) {
          continue;
        }
        codeblocks.push(codeblock);
        var precinct = precincts[precinctNumber];
        if (precinct !== undefined) {
          if (i < precinct.cbxMin) {
            precinct.cbxMin = i;
          } else if (i > precinct.cbxMax) {
            precinct.cbxMax = i;
          }
          if (j < precinct.cbyMin) {
            precinct.cbxMin = j;
          } else if (j > precinct.cbyMax) {
            precinct.cbyMax = j;
          }
        } else {
          precincts[precinctNumber] = precinct = {
            cbxMin: i,
            cbyMin: j,
            cbxMax: i,
            cbyMax: j
          };
        }
        codeblock.precinct = precinct;
      }
    }
    subband.codeblockParameters = {
      codeblockWidth: xcb_,
      codeblockHeight: ycb_,
      numcodeblockwide: cbx1 - cbx0 + 1,
      numcodeblockhigh: cby1 - cby0 + 1
    };
    subband.codeblocks = codeblocks;
    subband.precincts = precincts;
  }
  function createPacket(resolution, precinctNumber, layerNumber) {
    var precinctCodeblocks = [];
    var subbands = resolution.subbands;
    for (var i = 0, ii = subbands.length; i < ii; i++) {
      var subband = subbands[i];
      var codeblocks = subband.codeblocks;
      for (var j = 0, jj = codeblocks.length; j < jj; j++) {
        var codeblock = codeblocks[j];
        if (codeblock.precinctNumber !== precinctNumber) {
          continue;
        }
        precinctCodeblocks.push(codeblock);
      }
    }
    return {
      layerNumber: layerNumber,
      codeblocks: precinctCodeblocks
    };
  }
  function LayerResolutionComponentPositionIterator(context) {
    var siz = context.SIZ;
    var tileIndex = context.currentTile.index;
    var tile = context.tiles[tileIndex];
    var layersCount = tile.codingStyleDefaultParameters.layersCount;
    var componentsCount = siz.Csiz;
    var maxDecompositionLevelsCount = 0;
    for (var q = 0; q < componentsCount; q++) {
      maxDecompositionLevelsCount = Math.max(maxDecompositionLevelsCount, tile.components[q].codingStyleParameters.decompositionLevelsCount);
    }
    var l = 0,
        r = 0,
        i = 0,
        k = 0;
    this.nextPacket = function JpxImage_nextPacket() {
      for (; l < layersCount; l++) {
        for (; r <= maxDecompositionLevelsCount; r++) {
          for (; i < componentsCount; i++) {
            var component = tile.components[i];
            if (r > component.codingStyleParameters.decompositionLevelsCount) {
              continue;
            }
            var resolution = component.resolutions[r];
            var numprecincts = resolution.precinctParameters.numprecincts;
            for (; k < numprecincts;) {
              var packet = createPacket(resolution, k, l);
              k++;
              return packet;
            }
            k = 0;
          }
          i = 0;
        }
        r = 0;
      }
      error('JPX Error: Out of packets');
    };
  }
  function ResolutionLayerComponentPositionIterator(context) {
    var siz = context.SIZ;
    var tileIndex = context.currentTile.index;
    var tile = context.tiles[tileIndex];
    var layersCount = tile.codingStyleDefaultParameters.layersCount;
    var componentsCount = siz.Csiz;
    var maxDecompositionLevelsCount = 0;
    for (var q = 0; q < componentsCount; q++) {
      maxDecompositionLevelsCount = Math.max(maxDecompositionLevelsCount, tile.components[q].codingStyleParameters.decompositionLevelsCount);
    }
    var r = 0,
        l = 0,
        i = 0,
        k = 0;
    this.nextPacket = function JpxImage_nextPacket() {
      for (; r <= maxDecompositionLevelsCount; r++) {
        for (; l < layersCount; l++) {
          for (; i < componentsCount; i++) {
            var component = tile.components[i];
            if (r > component.codingStyleParameters.decompositionLevelsCount) {
              continue;
            }
            var resolution = component.resolutions[r];
            var numprecincts = resolution.precinctParameters.numprecincts;
            for (; k < numprecincts;) {
              var packet = createPacket(resolution, k, l);
              k++;
              return packet;
            }
            k = 0;
          }
          i = 0;
        }
        l = 0;
      }
      error('JPX Error: Out of packets');
    };
  }
  function ResolutionPositionComponentLayerIterator(context) {
    var siz = context.SIZ;
    var tileIndex = context.currentTile.index;
    var tile = context.tiles[tileIndex];
    var layersCount = tile.codingStyleDefaultParameters.layersCount;
    var componentsCount = siz.Csiz;
    var l, r, c, p;
    var maxDecompositionLevelsCount = 0;
    for (c = 0; c < componentsCount; c++) {
      var component = tile.components[c];
      maxDecompositionLevelsCount = Math.max(maxDecompositionLevelsCount, component.codingStyleParameters.decompositionLevelsCount);
    }
    var maxNumPrecinctsInLevel = new Int32Array(maxDecompositionLevelsCount + 1);
    for (r = 0; r <= maxDecompositionLevelsCount; ++r) {
      var maxNumPrecincts = 0;
      for (c = 0; c < componentsCount; ++c) {
        var resolutions = tile.components[c].resolutions;
        if (r < resolutions.length) {
          maxNumPrecincts = Math.max(maxNumPrecincts, resolutions[r].precinctParameters.numprecincts);
        }
      }
      maxNumPrecinctsInLevel[r] = maxNumPrecincts;
    }
    l = 0;
    r = 0;
    c = 0;
    p = 0;
    this.nextPacket = function JpxImage_nextPacket() {
      for (; r <= maxDecompositionLevelsCount; r++) {
        for (; p < maxNumPrecinctsInLevel[r]; p++) {
          for (; c < componentsCount; c++) {
            var component = tile.components[c];
            if (r > component.codingStyleParameters.decompositionLevelsCount) {
              continue;
            }
            var resolution = component.resolutions[r];
            var numprecincts = resolution.precinctParameters.numprecincts;
            if (p >= numprecincts) {
              continue;
            }
            for (; l < layersCount;) {
              var packet = createPacket(resolution, p, l);
              l++;
              return packet;
            }
            l = 0;
          }
          c = 0;
        }
        p = 0;
      }
      error('JPX Error: Out of packets');
    };
  }
  function PositionComponentResolutionLayerIterator(context) {
    var siz = context.SIZ;
    var tileIndex = context.currentTile.index;
    var tile = context.tiles[tileIndex];
    var layersCount = tile.codingStyleDefaultParameters.layersCount;
    var componentsCount = siz.Csiz;
    var precinctsSizes = getPrecinctSizesInImageScale(tile);
    var precinctsIterationSizes = precinctsSizes;
    var l = 0,
        r = 0,
        c = 0,
        px = 0,
        py = 0;
    this.nextPacket = function JpxImage_nextPacket() {
      for (; py < precinctsIterationSizes.maxNumHigh; py++) {
        for (; px < precinctsIterationSizes.maxNumWide; px++) {
          for (; c < componentsCount; c++) {
            var component = tile.components[c];
            var decompositionLevelsCount = component.codingStyleParameters.decompositionLevelsCount;
            for (; r <= decompositionLevelsCount; r++) {
              var resolution = component.resolutions[r];
              var sizeInImageScale = precinctsSizes.components[c].resolutions[r];
              var k = getPrecinctIndexIfExist(px, py, sizeInImageScale, precinctsIterationSizes, resolution);
              if (k === null) {
                continue;
              }
              for (; l < layersCount;) {
                var packet = createPacket(resolution, k, l);
                l++;
                return packet;
              }
              l = 0;
            }
            r = 0;
          }
          c = 0;
        }
        px = 0;
      }
      error('JPX Error: Out of packets');
    };
  }
  function ComponentPositionResolutionLayerIterator(context) {
    var siz = context.SIZ;
    var tileIndex = context.currentTile.index;
    var tile = context.tiles[tileIndex];
    var layersCount = tile.codingStyleDefaultParameters.layersCount;
    var componentsCount = siz.Csiz;
    var precinctsSizes = getPrecinctSizesInImageScale(tile);
    var l = 0,
        r = 0,
        c = 0,
        px = 0,
        py = 0;
    this.nextPacket = function JpxImage_nextPacket() {
      for (; c < componentsCount; ++c) {
        var component = tile.components[c];
        var precinctsIterationSizes = precinctsSizes.components[c];
        var decompositionLevelsCount = component.codingStyleParameters.decompositionLevelsCount;
        for (; py < precinctsIterationSizes.maxNumHigh; py++) {
          for (; px < precinctsIterationSizes.maxNumWide; px++) {
            for (; r <= decompositionLevelsCount; r++) {
              var resolution = component.resolutions[r];
              var sizeInImageScale = precinctsIterationSizes.resolutions[r];
              var k = getPrecinctIndexIfExist(px, py, sizeInImageScale, precinctsIterationSizes, resolution);
              if (k === null) {
                continue;
              }
              for (; l < layersCount;) {
                var packet = createPacket(resolution, k, l);
                l++;
                return packet;
              }
              l = 0;
            }
            r = 0;
          }
          px = 0;
        }
        py = 0;
      }
      error('JPX Error: Out of packets');
    };
  }
  function getPrecinctIndexIfExist(pxIndex, pyIndex, sizeInImageScale, precinctIterationSizes, resolution) {
    var posX = pxIndex * precinctIterationSizes.minWidth;
    var posY = pyIndex * precinctIterationSizes.minHeight;
    if (posX % sizeInImageScale.width !== 0 || posY % sizeInImageScale.height !== 0) {
      return null;
    }
    var startPrecinctRowIndex = posY / sizeInImageScale.width * resolution.precinctParameters.numprecinctswide;
    return posX / sizeInImageScale.height + startPrecinctRowIndex;
  }
  function getPrecinctSizesInImageScale(tile) {
    var componentsCount = tile.components.length;
    var minWidth = Number.MAX_VALUE;
    var minHeight = Number.MAX_VALUE;
    var maxNumWide = 0;
    var maxNumHigh = 0;
    var sizePerComponent = new Array(componentsCount);
    for (var c = 0; c < componentsCount; c++) {
      var component = tile.components[c];
      var decompositionLevelsCount = component.codingStyleParameters.decompositionLevelsCount;
      var sizePerResolution = new Array(decompositionLevelsCount + 1);
      var minWidthCurrentComponent = Number.MAX_VALUE;
      var minHeightCurrentComponent = Number.MAX_VALUE;
      var maxNumWideCurrentComponent = 0;
      var maxNumHighCurrentComponent = 0;
      var scale = 1;
      for (var r = decompositionLevelsCount; r >= 0; --r) {
        var resolution = component.resolutions[r];
        var widthCurrentResolution = scale * resolution.precinctParameters.precinctWidth;
        var heightCurrentResolution = scale * resolution.precinctParameters.precinctHeight;
        minWidthCurrentComponent = Math.min(minWidthCurrentComponent, widthCurrentResolution);
        minHeightCurrentComponent = Math.min(minHeightCurrentComponent, heightCurrentResolution);
        maxNumWideCurrentComponent = Math.max(maxNumWideCurrentComponent, resolution.precinctParameters.numprecinctswide);
        maxNumHighCurrentComponent = Math.max(maxNumHighCurrentComponent, resolution.precinctParameters.numprecinctshigh);
        sizePerResolution[r] = {
          width: widthCurrentResolution,
          height: heightCurrentResolution
        };
        scale <<= 1;
      }
      minWidth = Math.min(minWidth, minWidthCurrentComponent);
      minHeight = Math.min(minHeight, minHeightCurrentComponent);
      maxNumWide = Math.max(maxNumWide, maxNumWideCurrentComponent);
      maxNumHigh = Math.max(maxNumHigh, maxNumHighCurrentComponent);
      sizePerComponent[c] = {
        resolutions: sizePerResolution,
        minWidth: minWidthCurrentComponent,
        minHeight: minHeightCurrentComponent,
        maxNumWide: maxNumWideCurrentComponent,
        maxNumHigh: maxNumHighCurrentComponent
      };
    }
    return {
      components: sizePerComponent,
      minWidth: minWidth,
      minHeight: minHeight,
      maxNumWide: maxNumWide,
      maxNumHigh: maxNumHigh
    };
  }
  function buildPackets(context) {
    var siz = context.SIZ;
    var tileIndex = context.currentTile.index;
    var tile = context.tiles[tileIndex];
    var componentsCount = siz.Csiz;
    for (var c = 0; c < componentsCount; c++) {
      var component = tile.components[c];
      var decompositionLevelsCount = component.codingStyleParameters.decompositionLevelsCount;
      var resolutions = [];
      var subbands = [];
      for (var r = 0; r <= decompositionLevelsCount; r++) {
        var blocksDimensions = getBlocksDimensions(context, component, r);
        var resolution = {};
        var scale = 1 << decompositionLevelsCount - r;
        resolution.trx0 = Math.ceil(component.tcx0 / scale);
        resolution.try0 = Math.ceil(component.tcy0 / scale);
        resolution.trx1 = Math.ceil(component.tcx1 / scale);
        resolution.try1 = Math.ceil(component.tcy1 / scale);
        resolution.resLevel = r;
        buildPrecincts(context, resolution, blocksDimensions);
        resolutions.push(resolution);
        var subband;
        if (r === 0) {
          subband = {};
          subband.type = 'LL';
          subband.tbx0 = Math.ceil(component.tcx0 / scale);
          subband.tby0 = Math.ceil(component.tcy0 / scale);
          subband.tbx1 = Math.ceil(component.tcx1 / scale);
          subband.tby1 = Math.ceil(component.tcy1 / scale);
          subband.resolution = resolution;
          buildCodeblocks(context, subband, blocksDimensions);
          subbands.push(subband);
          resolution.subbands = [subband];
        } else {
          var bscale = 1 << decompositionLevelsCount - r + 1;
          var resolutionSubbands = [];
          subband = {};
          subband.type = 'HL';
          subband.tbx0 = Math.ceil(component.tcx0 / bscale - 0.5);
          subband.tby0 = Math.ceil(component.tcy0 / bscale);
          subband.tbx1 = Math.ceil(component.tcx1 / bscale - 0.5);
          subband.tby1 = Math.ceil(component.tcy1 / bscale);
          subband.resolution = resolution;
          buildCodeblocks(context, subband, blocksDimensions);
          subbands.push(subband);
          resolutionSubbands.push(subband);
          subband = {};
          subband.type = 'LH';
          subband.tbx0 = Math.ceil(component.tcx0 / bscale);
          subband.tby0 = Math.ceil(component.tcy0 / bscale - 0.5);
          subband.tbx1 = Math.ceil(component.tcx1 / bscale);
          subband.tby1 = Math.ceil(component.tcy1 / bscale - 0.5);
          subband.resolution = resolution;
          buildCodeblocks(context, subband, blocksDimensions);
          subbands.push(subband);
          resolutionSubbands.push(subband);
          subband = {};
          subband.type = 'HH';
          subband.tbx0 = Math.ceil(component.tcx0 / bscale - 0.5);
          subband.tby0 = Math.ceil(component.tcy0 / bscale - 0.5);
          subband.tbx1 = Math.ceil(component.tcx1 / bscale - 0.5);
          subband.tby1 = Math.ceil(component.tcy1 / bscale - 0.5);
          subband.resolution = resolution;
          buildCodeblocks(context, subband, blocksDimensions);
          subbands.push(subband);
          resolutionSubbands.push(subband);
          resolution.subbands = resolutionSubbands;
        }
      }
      component.resolutions = resolutions;
      component.subbands = subbands;
    }
    var progressionOrder = tile.codingStyleDefaultParameters.progressionOrder;
    switch (progressionOrder) {
      case 0:
        tile.packetsIterator = new LayerResolutionComponentPositionIterator(context);
        break;
      case 1:
        tile.packetsIterator = new ResolutionLayerComponentPositionIterator(context);
        break;
      case 2:
        tile.packetsIterator = new ResolutionPositionComponentLayerIterator(context);
        break;
      case 3:
        tile.packetsIterator = new PositionComponentResolutionLayerIterator(context);
        break;
      case 4:
        tile.packetsIterator = new ComponentPositionResolutionLayerIterator(context);
        break;
      default:
        error('JPX Error: Unsupported progression order ' + progressionOrder);
    }
  }
  function parseTilePackets(context, data, offset, dataLength) {
    var position = 0;
    var buffer,
        bufferSize = 0,
        skipNextBit = false;
    function readBits(count) {
      while (bufferSize < count) {
        var b = data[offset + position];
        position++;
        if (skipNextBit) {
          buffer = buffer << 7 | b;
          bufferSize += 7;
          skipNextBit = false;
        } else {
          buffer = buffer << 8 | b;
          bufferSize += 8;
        }
        if (b === 0xFF) {
          skipNextBit = true;
        }
      }
      bufferSize -= count;
      return buffer >>> bufferSize & (1 << count) - 1;
    }
    function skipMarkerIfEqual(value) {
      if (data[offset + position - 1] === 0xFF && data[offset + position] === value) {
        skipBytes(1);
        return true;
      } else if (data[offset + position] === 0xFF && data[offset + position + 1] === value) {
        skipBytes(2);
        return true;
      }
      return false;
    }
    function skipBytes(count) {
      position += count;
    }
    function alignToByte() {
      bufferSize = 0;
      if (skipNextBit) {
        position++;
        skipNextBit = false;
      }
    }
    function readCodingpasses() {
      if (readBits(1) === 0) {
        return 1;
      }
      if (readBits(1) === 0) {
        return 2;
      }
      var value = readBits(2);
      if (value < 3) {
        return value + 3;
      }
      value = readBits(5);
      if (value < 31) {
        return value + 6;
      }
      value = readBits(7);
      return value + 37;
    }
    var tileIndex = context.currentTile.index;
    var tile = context.tiles[tileIndex];
    var sopMarkerUsed = context.COD.sopMarkerUsed;
    var ephMarkerUsed = context.COD.ephMarkerUsed;
    var packetsIterator = tile.packetsIterator;
    while (position < dataLength) {
      alignToByte();
      if (sopMarkerUsed && skipMarkerIfEqual(0x91)) {
        skipBytes(4);
      }
      var packet = packetsIterator.nextPacket();
      if (!readBits(1)) {
        continue;
      }
      var layerNumber = packet.layerNumber;
      var queue = [],
          codeblock;
      for (var i = 0, ii = packet.codeblocks.length; i < ii; i++) {
        codeblock = packet.codeblocks[i];
        var precinct = codeblock.precinct;
        var codeblockColumn = codeblock.cbx - precinct.cbxMin;
        var codeblockRow = codeblock.cby - precinct.cbyMin;
        var codeblockIncluded = false;
        var firstTimeInclusion = false;
        var valueReady;
        if (codeblock['included'] !== undefined) {
          codeblockIncluded = !!readBits(1);
        } else {
          precinct = codeblock.precinct;
          var inclusionTree, zeroBitPlanesTree;
          if (precinct['inclusionTree'] !== undefined) {
            inclusionTree = precinct.inclusionTree;
          } else {
            var width = precinct.cbxMax - precinct.cbxMin + 1;
            var height = precinct.cbyMax - precinct.cbyMin + 1;
            inclusionTree = new InclusionTree(width, height, layerNumber);
            zeroBitPlanesTree = new TagTree(width, height);
            precinct.inclusionTree = inclusionTree;
            precinct.zeroBitPlanesTree = zeroBitPlanesTree;
          }
          if (inclusionTree.reset(codeblockColumn, codeblockRow, layerNumber)) {
            while (true) {
              if (readBits(1)) {
                valueReady = !inclusionTree.nextLevel();
                if (valueReady) {
                  codeblock.included = true;
                  codeblockIncluded = firstTimeInclusion = true;
                  break;
                }
              } else {
                inclusionTree.incrementValue(layerNumber);
                break;
              }
            }
          }
        }
        if (!codeblockIncluded) {
          continue;
        }
        if (firstTimeInclusion) {
          zeroBitPlanesTree = precinct.zeroBitPlanesTree;
          zeroBitPlanesTree.reset(codeblockColumn, codeblockRow);
          while (true) {
            if (readBits(1)) {
              valueReady = !zeroBitPlanesTree.nextLevel();
              if (valueReady) {
                break;
              }
            } else {
              zeroBitPlanesTree.incrementValue();
            }
          }
          codeblock.zeroBitPlanes = zeroBitPlanesTree.value;
        }
        var codingpasses = readCodingpasses();
        while (readBits(1)) {
          codeblock.Lblock++;
        }
        var codingpassesLog2 = log2(codingpasses);
        var bits = (codingpasses < 1 << codingpassesLog2 ? codingpassesLog2 - 1 : codingpassesLog2) + codeblock.Lblock;
        var codedDataLength = readBits(bits);
        queue.push({
          codeblock: codeblock,
          codingpasses: codingpasses,
          dataLength: codedDataLength
        });
      }
      alignToByte();
      if (ephMarkerUsed) {
        skipMarkerIfEqual(0x92);
      }
      while (queue.length > 0) {
        var packetItem = queue.shift();
        codeblock = packetItem.codeblock;
        if (codeblock['data'] === undefined) {
          codeblock.data = [];
        }
        codeblock.data.push({
          data: data,
          start: offset + position,
          end: offset + position + packetItem.dataLength,
          codingpasses: packetItem.codingpasses
        });
        position += packetItem.dataLength;
      }
    }
    return position;
  }
  function copyCoefficients(coefficients, levelWidth, levelHeight, subband, delta, mb, reversible, segmentationSymbolUsed) {
    var x0 = subband.tbx0;
    var y0 = subband.tby0;
    var width = subband.tbx1 - subband.tbx0;
    var codeblocks = subband.codeblocks;
    var right = subband.type.charAt(0) === 'H' ? 1 : 0;
    var bottom = subband.type.charAt(1) === 'H' ? levelWidth : 0;
    for (var i = 0, ii = codeblocks.length; i < ii; ++i) {
      var codeblock = codeblocks[i];
      var blockWidth = codeblock.tbx1_ - codeblock.tbx0_;
      var blockHeight = codeblock.tby1_ - codeblock.tby0_;
      if (blockWidth === 0 || blockHeight === 0) {
        continue;
      }
      if (codeblock['data'] === undefined) {
        continue;
      }
      var bitModel, currentCodingpassType;
      bitModel = new BitModel(blockWidth, blockHeight, codeblock.subbandType, codeblock.zeroBitPlanes, mb);
      currentCodingpassType = 2;
      var data = codeblock.data,
          totalLength = 0,
          codingpasses = 0;
      var j, jj, dataItem;
      for (j = 0, jj = data.length; j < jj; j++) {
        dataItem = data[j];
        totalLength += dataItem.end - dataItem.start;
        codingpasses += dataItem.codingpasses;
      }
      var encodedData = new Uint8Array(totalLength);
      var position = 0;
      for (j = 0, jj = data.length; j < jj; j++) {
        dataItem = data[j];
        var chunk = dataItem.data.subarray(dataItem.start, dataItem.end);
        encodedData.set(chunk, position);
        position += chunk.length;
      }
      var decoder = new ArithmeticDecoder(encodedData, 0, totalLength);
      bitModel.setDecoder(decoder);
      for (j = 0; j < codingpasses; j++) {
        switch (currentCodingpassType) {
          case 0:
            bitModel.runSignificancePropagationPass();
            break;
          case 1:
            bitModel.runMagnitudeRefinementPass();
            break;
          case 2:
            bitModel.runCleanupPass();
            if (segmentationSymbolUsed) {
              bitModel.checkSegmentationSymbol();
            }
            break;
        }
        currentCodingpassType = (currentCodingpassType + 1) % 3;
      }
      var offset = codeblock.tbx0_ - x0 + (codeblock.tby0_ - y0) * width;
      var sign = bitModel.coefficentsSign;
      var magnitude = bitModel.coefficentsMagnitude;
      var bitsDecoded = bitModel.bitsDecoded;
      var magnitudeCorrection = reversible ? 0 : 0.5;
      var k, n, nb;
      position = 0;
      var interleave = subband.type !== 'LL';
      for (j = 0; j < blockHeight; j++) {
        var row = offset / width | 0;
        var levelOffset = 2 * row * (levelWidth - width) + right + bottom;
        for (k = 0; k < blockWidth; k++) {
          n = magnitude[position];
          if (n !== 0) {
            n = (n + magnitudeCorrection) * delta;
            if (sign[position] !== 0) {
              n = -n;
            }
            nb = bitsDecoded[position];
            var pos = interleave ? levelOffset + (offset << 1) : offset;
            if (reversible && nb >= mb) {
              coefficients[pos] = n;
            } else {
              coefficients[pos] = n * (1 << mb - nb);
            }
          }
          offset++;
          position++;
        }
        offset += width - blockWidth;
      }
    }
  }
  function transformTile(context, tile, c) {
    var component = tile.components[c];
    var codingStyleParameters = component.codingStyleParameters;
    var quantizationParameters = component.quantizationParameters;
    var decompositionLevelsCount = codingStyleParameters.decompositionLevelsCount;
    var spqcds = quantizationParameters.SPqcds;
    var scalarExpounded = quantizationParameters.scalarExpounded;
    var guardBits = quantizationParameters.guardBits;
    var segmentationSymbolUsed = codingStyleParameters.segmentationSymbolUsed;
    var precision = context.components[c].precision;
    var reversible = codingStyleParameters.reversibleTransformation;
    var transform = reversible ? new ReversibleTransform() : new IrreversibleTransform();
    var subbandCoefficients = [];
    var b = 0;
    for (var i = 0; i <= decompositionLevelsCount; i++) {
      var resolution = component.resolutions[i];
      var width = resolution.trx1 - resolution.trx0;
      var height = resolution.try1 - resolution.try0;
      var coefficients = new Float32Array(width * height);
      for (var j = 0, jj = resolution.subbands.length; j < jj; j++) {
        var mu, epsilon;
        if (!scalarExpounded) {
          mu = spqcds[0].mu;
          epsilon = spqcds[0].epsilon + (i > 0 ? 1 - i : 0);
        } else {
          mu = spqcds[b].mu;
          epsilon = spqcds[b].epsilon;
          b++;
        }
        var subband = resolution.subbands[j];
        var gainLog2 = SubbandsGainLog2[subband.type];
        var delta = reversible ? 1 : Math.pow(2, precision + gainLog2 - epsilon) * (1 + mu / 2048);
        var mb = guardBits + epsilon - 1;
        copyCoefficients(coefficients, width, height, subband, delta, mb, reversible, segmentationSymbolUsed);
      }
      subbandCoefficients.push({
        width: width,
        height: height,
        items: coefficients
      });
    }
    var result = transform.calculate(subbandCoefficients, component.tcx0, component.tcy0);
    return {
      left: component.tcx0,
      top: component.tcy0,
      width: result.width,
      height: result.height,
      items: result.items
    };
  }
  function transformComponents(context) {
    var siz = context.SIZ;
    var components = context.components;
    var componentsCount = siz.Csiz;
    var resultImages = [];
    for (var i = 0, ii = context.tiles.length; i < ii; i++) {
      var tile = context.tiles[i];
      var transformedTiles = [];
      var c;
      for (c = 0; c < componentsCount; c++) {
        transformedTiles[c] = transformTile(context, tile, c);
      }
      var tile0 = transformedTiles[0];
      var out = new Uint8Array(tile0.items.length * componentsCount);
      var result = {
        left: tile0.left,
        top: tile0.top,
        width: tile0.width,
        height: tile0.height,
        items: out
      };
      var shift, offset, max, min, maxK;
      var pos = 0,
          j,
          jj,
          y0,
          y1,
          y2,
          r,
          g,
          b,
          k,
          val;
      if (tile.codingStyleDefaultParameters.multipleComponentTransform) {
        var fourComponents = componentsCount === 4;
        var y0items = transformedTiles[0].items;
        var y1items = transformedTiles[1].items;
        var y2items = transformedTiles[2].items;
        var y3items = fourComponents ? transformedTiles[3].items : null;
        shift = components[0].precision - 8;
        offset = (128 << shift) + 0.5;
        max = 255 * (1 << shift);
        maxK = max * 0.5;
        min = -maxK;
        var component0 = tile.components[0];
        var alpha01 = componentsCount - 3;
        jj = y0items.length;
        if (!component0.codingStyleParameters.reversibleTransformation) {
          for (j = 0; j < jj; j++, pos += alpha01) {
            y0 = y0items[j] + offset;
            y1 = y1items[j];
            y2 = y2items[j];
            r = y0 + 1.402 * y2;
            g = y0 - 0.34413 * y1 - 0.71414 * y2;
            b = y0 + 1.772 * y1;
            out[pos++] = r <= 0 ? 0 : r >= max ? 255 : r >> shift;
            out[pos++] = g <= 0 ? 0 : g >= max ? 255 : g >> shift;
            out[pos++] = b <= 0 ? 0 : b >= max ? 255 : b >> shift;
          }
        } else {
          for (j = 0; j < jj; j++, pos += alpha01) {
            y0 = y0items[j] + offset;
            y1 = y1items[j];
            y2 = y2items[j];
            g = y0 - (y2 + y1 >> 2);
            r = g + y2;
            b = g + y1;
            out[pos++] = r <= 0 ? 0 : r >= max ? 255 : r >> shift;
            out[pos++] = g <= 0 ? 0 : g >= max ? 255 : g >> shift;
            out[pos++] = b <= 0 ? 0 : b >= max ? 255 : b >> shift;
          }
        }
        if (fourComponents) {
          for (j = 0, pos = 3; j < jj; j++, pos += 4) {
            k = y3items[j];
            out[pos] = k <= min ? 0 : k >= maxK ? 255 : k + offset >> shift;
          }
        }
      } else {
        for (c = 0; c < componentsCount; c++) {
          var items = transformedTiles[c].items;
          shift = components[c].precision - 8;
          offset = (128 << shift) + 0.5;
          max = 127.5 * (1 << shift);
          min = -max;
          for (pos = c, j = 0, jj = items.length; j < jj; j++) {
            val = items[j];
            out[pos] = val <= min ? 0 : val >= max ? 255 : val + offset >> shift;
            pos += componentsCount;
          }
        }
      }
      resultImages.push(result);
    }
    return resultImages;
  }
  function initializeTile(context, tileIndex) {
    var siz = context.SIZ;
    var componentsCount = siz.Csiz;
    var tile = context.tiles[tileIndex];
    for (var c = 0; c < componentsCount; c++) {
      var component = tile.components[c];
      var qcdOrQcc = context.currentTile.QCC[c] !== undefined ? context.currentTile.QCC[c] : context.currentTile.QCD;
      component.quantizationParameters = qcdOrQcc;
      var codOrCoc = context.currentTile.COC[c] !== undefined ? context.currentTile.COC[c] : context.currentTile.COD;
      component.codingStyleParameters = codOrCoc;
    }
    tile.codingStyleDefaultParameters = context.currentTile.COD;
  }
  var TagTree = function TagTreeClosure() {
    function TagTree(width, height) {
      var levelsLength = log2(Math.max(width, height)) + 1;
      this.levels = [];
      for (var i = 0; i < levelsLength; i++) {
        var level = {
          width: width,
          height: height,
          items: []
        };
        this.levels.push(level);
        width = Math.ceil(width / 2);
        height = Math.ceil(height / 2);
      }
    }
    TagTree.prototype = {
      reset: function TagTree_reset(i, j) {
        var currentLevel = 0,
            value = 0,
            level;
        while (currentLevel < this.levels.length) {
          level = this.levels[currentLevel];
          var index = i + j * level.width;
          if (level.items[index] !== undefined) {
            value = level.items[index];
            break;
          }
          level.index = index;
          i >>= 1;
          j >>= 1;
          currentLevel++;
        }
        currentLevel--;
        level = this.levels[currentLevel];
        level.items[level.index] = value;
        this.currentLevel = currentLevel;
        delete this.value;
      },
      incrementValue: function TagTree_incrementValue() {
        var level = this.levels[this.currentLevel];
        level.items[level.index]++;
      },
      nextLevel: function TagTree_nextLevel() {
        var currentLevel = this.currentLevel;
        var level = this.levels[currentLevel];
        var value = level.items[level.index];
        currentLevel--;
        if (currentLevel < 0) {
          this.value = value;
          return false;
        }
        this.currentLevel = currentLevel;
        level = this.levels[currentLevel];
        level.items[level.index] = value;
        return true;
      }
    };
    return TagTree;
  }();
  var InclusionTree = function InclusionTreeClosure() {
    function InclusionTree(width, height, defaultValue) {
      var levelsLength = log2(Math.max(width, height)) + 1;
      this.levels = [];
      for (var i = 0; i < levelsLength; i++) {
        var items = new Uint8Array(width * height);
        for (var j = 0, jj = items.length; j < jj; j++) {
          items[j] = defaultValue;
        }
        var level = {
          width: width,
          height: height,
          items: items
        };
        this.levels.push(level);
        width = Math.ceil(width / 2);
        height = Math.ceil(height / 2);
      }
    }
    InclusionTree.prototype = {
      reset: function InclusionTree_reset(i, j, stopValue) {
        var currentLevel = 0;
        while (currentLevel < this.levels.length) {
          var level = this.levels[currentLevel];
          var index = i + j * level.width;
          level.index = index;
          var value = level.items[index];
          if (value === 0xFF) {
            break;
          }
          if (value > stopValue) {
            this.currentLevel = currentLevel;
            this.propagateValues();
            return false;
          }
          i >>= 1;
          j >>= 1;
          currentLevel++;
        }
        this.currentLevel = currentLevel - 1;
        return true;
      },
      incrementValue: function InclusionTree_incrementValue(stopValue) {
        var level = this.levels[this.currentLevel];
        level.items[level.index] = stopValue + 1;
        this.propagateValues();
      },
      propagateValues: function InclusionTree_propagateValues() {
        var levelIndex = this.currentLevel;
        var level = this.levels[levelIndex];
        var currentValue = level.items[level.index];
        while (--levelIndex >= 0) {
          level = this.levels[levelIndex];
          level.items[level.index] = currentValue;
        }
      },
      nextLevel: function InclusionTree_nextLevel() {
        var currentLevel = this.currentLevel;
        var level = this.levels[currentLevel];
        var value = level.items[level.index];
        level.items[level.index] = 0xFF;
        currentLevel--;
        if (currentLevel < 0) {
          return false;
        }
        this.currentLevel = currentLevel;
        level = this.levels[currentLevel];
        level.items[level.index] = value;
        return true;
      }
    };
    return InclusionTree;
  }();
  var BitModel = function BitModelClosure() {
    var UNIFORM_CONTEXT = 17;
    var RUNLENGTH_CONTEXT = 18;
    var LLAndLHContextsLabel = new Uint8Array([0, 5, 8, 0, 3, 7, 8, 0, 4, 7, 8, 0, 0, 0, 0, 0, 1, 6, 8, 0, 3, 7, 8, 0, 4, 7, 8, 0, 0, 0, 0, 0, 2, 6, 8, 0, 3, 7, 8, 0, 4, 7, 8, 0, 0, 0, 0, 0, 2, 6, 8, 0, 3, 7, 8, 0, 4, 7, 8, 0, 0, 0, 0, 0, 2, 6, 8, 0, 3, 7, 8, 0, 4, 7, 8]);
    var HLContextLabel = new Uint8Array([0, 3, 4, 0, 5, 7, 7, 0, 8, 8, 8, 0, 0, 0, 0, 0, 1, 3, 4, 0, 6, 7, 7, 0, 8, 8, 8, 0, 0, 0, 0, 0, 2, 3, 4, 0, 6, 7, 7, 0, 8, 8, 8, 0, 0, 0, 0, 0, 2, 3, 4, 0, 6, 7, 7, 0, 8, 8, 8, 0, 0, 0, 0, 0, 2, 3, 4, 0, 6, 7, 7, 0, 8, 8, 8]);
    var HHContextLabel = new Uint8Array([0, 1, 2, 0, 1, 2, 2, 0, 2, 2, 2, 0, 0, 0, 0, 0, 3, 4, 5, 0, 4, 5, 5, 0, 5, 5, 5, 0, 0, 0, 0, 0, 6, 7, 7, 0, 7, 7, 7, 0, 7, 7, 7, 0, 0, 0, 0, 0, 8, 8, 8, 0, 8, 8, 8, 0, 8, 8, 8, 0, 0, 0, 0, 0, 8, 8, 8, 0, 8, 8, 8, 0, 8, 8, 8]);
    function BitModel(width, height, subband, zeroBitPlanes, mb) {
      this.width = width;
      this.height = height;
      this.contextLabelTable = subband === 'HH' ? HHContextLabel : subband === 'HL' ? HLContextLabel : LLAndLHContextsLabel;
      var coefficientCount = width * height;
      this.neighborsSignificance = new Uint8Array(coefficientCount);
      this.coefficentsSign = new Uint8Array(coefficientCount);
      this.coefficentsMagnitude = mb > 14 ? new Uint32Array(coefficientCount) : mb > 6 ? new Uint16Array(coefficientCount) : new Uint8Array(coefficientCount);
      this.processingFlags = new Uint8Array(coefficientCount);
      var bitsDecoded = new Uint8Array(coefficientCount);
      if (zeroBitPlanes !== 0) {
        for (var i = 0; i < coefficientCount; i++) {
          bitsDecoded[i] = zeroBitPlanes;
        }
      }
      this.bitsDecoded = bitsDecoded;
      this.reset();
    }
    BitModel.prototype = {
      setDecoder: function BitModel_setDecoder(decoder) {
        this.decoder = decoder;
      },
      reset: function BitModel_reset() {
        this.contexts = new Int8Array(19);
        this.contexts[0] = 4 << 1 | 0;
        this.contexts[UNIFORM_CONTEXT] = 46 << 1 | 0;
        this.contexts[RUNLENGTH_CONTEXT] = 3 << 1 | 0;
      },
      setNeighborsSignificance: function BitModel_setNeighborsSignificance(row, column, index) {
        var neighborsSignificance = this.neighborsSignificance;
        var width = this.width,
            height = this.height;
        var left = column > 0;
        var right = column + 1 < width;
        var i;
        if (row > 0) {
          i = index - width;
          if (left) {
            neighborsSignificance[i - 1] += 0x10;
          }
          if (right) {
            neighborsSignificance[i + 1] += 0x10;
          }
          neighborsSignificance[i] += 0x04;
        }
        if (row + 1 < height) {
          i = index + width;
          if (left) {
            neighborsSignificance[i - 1] += 0x10;
          }
          if (right) {
            neighborsSignificance[i + 1] += 0x10;
          }
          neighborsSignificance[i] += 0x04;
        }
        if (left) {
          neighborsSignificance[index - 1] += 0x01;
        }
        if (right) {
          neighborsSignificance[index + 1] += 0x01;
        }
        neighborsSignificance[index] |= 0x80;
      },
      runSignificancePropagationPass: function BitModel_runSignificancePropagationPass() {
        var decoder = this.decoder;
        var width = this.width,
            height = this.height;
        var coefficentsMagnitude = this.coefficentsMagnitude;
        var coefficentsSign = this.coefficentsSign;
        var neighborsSignificance = this.neighborsSignificance;
        var processingFlags = this.processingFlags;
        var contexts = this.contexts;
        var labels = this.contextLabelTable;
        var bitsDecoded = this.bitsDecoded;
        var processedInverseMask = ~1;
        var processedMask = 1;
        var firstMagnitudeBitMask = 2;
        for (var i0 = 0; i0 < height; i0 += 4) {
          for (var j = 0; j < width; j++) {
            var index = i0 * width + j;
            for (var i1 = 0; i1 < 4; i1++, index += width) {
              var i = i0 + i1;
              if (i >= height) {
                break;
              }
              processingFlags[index] &= processedInverseMask;
              if (coefficentsMagnitude[index] || !neighborsSignificance[index]) {
                continue;
              }
              var contextLabel = labels[neighborsSignificance[index]];
              var decision = decoder.readBit(contexts, contextLabel);
              if (decision) {
                var sign = this.decodeSignBit(i, j, index);
                coefficentsSign[index] = sign;
                coefficentsMagnitude[index] = 1;
                this.setNeighborsSignificance(i, j, index);
                processingFlags[index] |= firstMagnitudeBitMask;
              }
              bitsDecoded[index]++;
              processingFlags[index] |= processedMask;
            }
          }
        }
      },
      decodeSignBit: function BitModel_decodeSignBit(row, column, index) {
        var width = this.width,
            height = this.height;
        var coefficentsMagnitude = this.coefficentsMagnitude;
        var coefficentsSign = this.coefficentsSign;
        var contribution, sign0, sign1, significance1;
        var contextLabel, decoded;
        significance1 = column > 0 && coefficentsMagnitude[index - 1] !== 0;
        if (column + 1 < width && coefficentsMagnitude[index + 1] !== 0) {
          sign1 = coefficentsSign[index + 1];
          if (significance1) {
            sign0 = coefficentsSign[index - 1];
            contribution = 1 - sign1 - sign0;
          } else {
            contribution = 1 - sign1 - sign1;
          }
        } else if (significance1) {
          sign0 = coefficentsSign[index - 1];
          contribution = 1 - sign0 - sign0;
        } else {
          contribution = 0;
        }
        var horizontalContribution = 3 * contribution;
        significance1 = row > 0 && coefficentsMagnitude[index - width] !== 0;
        if (row + 1 < height && coefficentsMagnitude[index + width] !== 0) {
          sign1 = coefficentsSign[index + width];
          if (significance1) {
            sign0 = coefficentsSign[index - width];
            contribution = 1 - sign1 - sign0 + horizontalContribution;
          } else {
            contribution = 1 - sign1 - sign1 + horizontalContribution;
          }
        } else if (significance1) {
          sign0 = coefficentsSign[index - width];
          contribution = 1 - sign0 - sign0 + horizontalContribution;
        } else {
          contribution = horizontalContribution;
        }
        if (contribution >= 0) {
          contextLabel = 9 + contribution;
          decoded = this.decoder.readBit(this.contexts, contextLabel);
        } else {
          contextLabel = 9 - contribution;
          decoded = this.decoder.readBit(this.contexts, contextLabel) ^ 1;
        }
        return decoded;
      },
      runMagnitudeRefinementPass: function BitModel_runMagnitudeRefinementPass() {
        var decoder = this.decoder;
        var width = this.width,
            height = this.height;
        var coefficentsMagnitude = this.coefficentsMagnitude;
        var neighborsSignificance = this.neighborsSignificance;
        var contexts = this.contexts;
        var bitsDecoded = this.bitsDecoded;
        var processingFlags = this.processingFlags;
        var processedMask = 1;
        var firstMagnitudeBitMask = 2;
        var length = width * height;
        var width4 = width * 4;
        for (var index0 = 0, indexNext; index0 < length; index0 = indexNext) {
          indexNext = Math.min(length, index0 + width4);
          for (var j = 0; j < width; j++) {
            for (var index = index0 + j; index < indexNext; index += width) {
              if (!coefficentsMagnitude[index] || (processingFlags[index] & processedMask) !== 0) {
                continue;
              }
              var contextLabel = 16;
              if ((processingFlags[index] & firstMagnitudeBitMask) !== 0) {
                processingFlags[index] ^= firstMagnitudeBitMask;
                var significance = neighborsSignificance[index] & 127;
                contextLabel = significance === 0 ? 15 : 14;
              }
              var bit = decoder.readBit(contexts, contextLabel);
              coefficentsMagnitude[index] = coefficentsMagnitude[index] << 1 | bit;
              bitsDecoded[index]++;
              processingFlags[index] |= processedMask;
            }
          }
        }
      },
      runCleanupPass: function BitModel_runCleanupPass() {
        var decoder = this.decoder;
        var width = this.width,
            height = this.height;
        var neighborsSignificance = this.neighborsSignificance;
        var coefficentsMagnitude = this.coefficentsMagnitude;
        var coefficentsSign = this.coefficentsSign;
        var contexts = this.contexts;
        var labels = this.contextLabelTable;
        var bitsDecoded = this.bitsDecoded;
        var processingFlags = this.processingFlags;
        var processedMask = 1;
        var firstMagnitudeBitMask = 2;
        var oneRowDown = width;
        var twoRowsDown = width * 2;
        var threeRowsDown = width * 3;
        var iNext;
        for (var i0 = 0; i0 < height; i0 = iNext) {
          iNext = Math.min(i0 + 4, height);
          var indexBase = i0 * width;
          var checkAllEmpty = i0 + 3 < height;
          for (var j = 0; j < width; j++) {
            var index0 = indexBase + j;
            var allEmpty = checkAllEmpty && processingFlags[index0] === 0 && processingFlags[index0 + oneRowDown] === 0 && processingFlags[index0 + twoRowsDown] === 0 && processingFlags[index0 + threeRowsDown] === 0 && neighborsSignificance[index0] === 0 && neighborsSignificance[index0 + oneRowDown] === 0 && neighborsSignificance[index0 + twoRowsDown] === 0 && neighborsSignificance[index0 + threeRowsDown] === 0;
            var i1 = 0,
                index = index0;
            var i = i0,
                sign;
            if (allEmpty) {
              var hasSignificantCoefficent = decoder.readBit(contexts, RUNLENGTH_CONTEXT);
              if (!hasSignificantCoefficent) {
                bitsDecoded[index0]++;
                bitsDecoded[index0 + oneRowDown]++;
                bitsDecoded[index0 + twoRowsDown]++;
                bitsDecoded[index0 + threeRowsDown]++;
                continue;
              }
              i1 = decoder.readBit(contexts, UNIFORM_CONTEXT) << 1 | decoder.readBit(contexts, UNIFORM_CONTEXT);
              if (i1 !== 0) {
                i = i0 + i1;
                index += i1 * width;
              }
              sign = this.decodeSignBit(i, j, index);
              coefficentsSign[index] = sign;
              coefficentsMagnitude[index] = 1;
              this.setNeighborsSignificance(i, j, index);
              processingFlags[index] |= firstMagnitudeBitMask;
              index = index0;
              for (var i2 = i0; i2 <= i; i2++, index += width) {
                bitsDecoded[index]++;
              }
              i1++;
            }
            for (i = i0 + i1; i < iNext; i++, index += width) {
              if (coefficentsMagnitude[index] || (processingFlags[index] & processedMask) !== 0) {
                continue;
              }
              var contextLabel = labels[neighborsSignificance[index]];
              var decision = decoder.readBit(contexts, contextLabel);
              if (decision === 1) {
                sign = this.decodeSignBit(i, j, index);
                coefficentsSign[index] = sign;
                coefficentsMagnitude[index] = 1;
                this.setNeighborsSignificance(i, j, index);
                processingFlags[index] |= firstMagnitudeBitMask;
              }
              bitsDecoded[index]++;
            }
          }
        }
      },
      checkSegmentationSymbol: function BitModel_checkSegmentationSymbol() {
        var decoder = this.decoder;
        var contexts = this.contexts;
        var symbol = decoder.readBit(contexts, UNIFORM_CONTEXT) << 3 | decoder.readBit(contexts, UNIFORM_CONTEXT) << 2 | decoder.readBit(contexts, UNIFORM_CONTEXT) << 1 | decoder.readBit(contexts, UNIFORM_CONTEXT);
        if (symbol !== 0xA) {
          error('JPX Error: Invalid segmentation symbol');
        }
      }
    };
    return BitModel;
  }();
  var Transform = function TransformClosure() {
    function Transform() {}
    Transform.prototype.calculate = function transformCalculate(subbands, u0, v0) {
      var ll = subbands[0];
      for (var i = 1, ii = subbands.length; i < ii; i++) {
        ll = this.iterate(ll, subbands[i], u0, v0);
      }
      return ll;
    };
    Transform.prototype.extend = function extend(buffer, offset, size) {
      var i1 = offset - 1,
          j1 = offset + 1;
      var i2 = offset + size - 2,
          j2 = offset + size;
      buffer[i1--] = buffer[j1++];
      buffer[j2++] = buffer[i2--];
      buffer[i1--] = buffer[j1++];
      buffer[j2++] = buffer[i2--];
      buffer[i1--] = buffer[j1++];
      buffer[j2++] = buffer[i2--];
      buffer[i1] = buffer[j1];
      buffer[j2] = buffer[i2];
    };
    Transform.prototype.iterate = function Transform_iterate(ll, hl_lh_hh, u0, v0) {
      var llWidth = ll.width,
          llHeight = ll.height,
          llItems = ll.items;
      var width = hl_lh_hh.width;
      var height = hl_lh_hh.height;
      var items = hl_lh_hh.items;
      var i, j, k, l, u, v;
      for (k = 0, i = 0; i < llHeight; i++) {
        l = i * 2 * width;
        for (j = 0; j < llWidth; j++, k++, l += 2) {
          items[l] = llItems[k];
        }
      }
      llItems = ll.items = null;
      var bufferPadding = 4;
      var rowBuffer = new Float32Array(width + 2 * bufferPadding);
      if (width === 1) {
        if ((u0 & 1) !== 0) {
          for (v = 0, k = 0; v < height; v++, k += width) {
            items[k] *= 0.5;
          }
        }
      } else {
        for (v = 0, k = 0; v < height; v++, k += width) {
          rowBuffer.set(items.subarray(k, k + width), bufferPadding);
          this.extend(rowBuffer, bufferPadding, width);
          this.filter(rowBuffer, bufferPadding, width);
          items.set(rowBuffer.subarray(bufferPadding, bufferPadding + width), k);
        }
      }
      var numBuffers = 16;
      var colBuffers = [];
      for (i = 0; i < numBuffers; i++) {
        colBuffers.push(new Float32Array(height + 2 * bufferPadding));
      }
      var b,
          currentBuffer = 0;
      ll = bufferPadding + height;
      if (height === 1) {
        if ((v0 & 1) !== 0) {
          for (u = 0; u < width; u++) {
            items[u] *= 0.5;
          }
        }
      } else {
        for (u = 0; u < width; u++) {
          if (currentBuffer === 0) {
            numBuffers = Math.min(width - u, numBuffers);
            for (k = u, l = bufferPadding; l < ll; k += width, l++) {
              for (b = 0; b < numBuffers; b++) {
                colBuffers[b][l] = items[k + b];
              }
            }
            currentBuffer = numBuffers;
          }
          currentBuffer--;
          var buffer = colBuffers[currentBuffer];
          this.extend(buffer, bufferPadding, height);
          this.filter(buffer, bufferPadding, height);
          if (currentBuffer === 0) {
            k = u - numBuffers + 1;
            for (l = bufferPadding; l < ll; k += width, l++) {
              for (b = 0; b < numBuffers; b++) {
                items[k + b] = colBuffers[b][l];
              }
            }
          }
        }
      }
      return {
        width: width,
        height: height,
        items: items
      };
    };
    return Transform;
  }();
  var IrreversibleTransform = function IrreversibleTransformClosure() {
    function IrreversibleTransform() {
      Transform.call(this);
    }
    IrreversibleTransform.prototype = Object.create(Transform.prototype);
    IrreversibleTransform.prototype.filter = function irreversibleTransformFilter(x, offset, length) {
      var len = length >> 1;
      offset = offset | 0;
      var j, n, current, next;
      var alpha = -1.586134342059924;
      var beta = -0.052980118572961;
      var gamma = 0.882911075530934;
      var delta = 0.443506852043971;
      var K = 1.230174104914001;
      var K_ = 1 / K;
      j = offset - 3;
      for (n = len + 4; n--; j += 2) {
        x[j] *= K_;
      }
      j = offset - 2;
      current = delta * x[j - 1];
      for (n = len + 3; n--; j += 2) {
        next = delta * x[j + 1];
        x[j] = K * x[j] - current - next;
        if (n--) {
          j += 2;
          current = delta * x[j + 1];
          x[j] = K * x[j] - current - next;
        } else {
          break;
        }
      }
      j = offset - 1;
      current = gamma * x[j - 1];
      for (n = len + 2; n--; j += 2) {
        next = gamma * x[j + 1];
        x[j] -= current + next;
        if (n--) {
          j += 2;
          current = gamma * x[j + 1];
          x[j] -= current + next;
        } else {
          break;
        }
      }
      j = offset;
      current = beta * x[j - 1];
      for (n = len + 1; n--; j += 2) {
        next = beta * x[j + 1];
        x[j] -= current + next;
        if (n--) {
          j += 2;
          current = beta * x[j + 1];
          x[j] -= current + next;
        } else {
          break;
        }
      }
      if (len !== 0) {
        j = offset + 1;
        current = alpha * x[j - 1];
        for (n = len; n--; j += 2) {
          next = alpha * x[j + 1];
          x[j] -= current + next;
          if (n--) {
            j += 2;
            current = alpha * x[j + 1];
            x[j] -= current + next;
          } else {
            break;
          }
        }
      }
    };
    return IrreversibleTransform;
  }();
  var ReversibleTransform = function ReversibleTransformClosure() {
    function ReversibleTransform() {
      Transform.call(this);
    }
    ReversibleTransform.prototype = Object.create(Transform.prototype);
    ReversibleTransform.prototype.filter = function reversibleTransformFilter(x, offset, length) {
      var len = length >> 1;
      offset = offset | 0;
      var j, n;
      for (j = offset, n = len + 1; n--; j += 2) {
        x[j] -= x[j - 1] + x[j + 1] + 2 >> 2;
      }
      for (j = offset + 1, n = len; n--; j += 2) {
        x[j] += x[j - 1] + x[j + 1] >> 1;
      }
    };
    return ReversibleTransform;
  }();
  return JpxImage;
}();

	
	"use strict";
    
	var Jbig2Image = function Jbig2ImageClosure() {
  function ContextCache() {}
  ContextCache.prototype = {
    getContexts: function (id) {
      if (id in this) {
        return this[id];
      }
      return this[id] = new Int8Array(1 << 16);
    }
  };
  function DecodingContext(data, start, end) {
    this.data = data;
    this.start = start;
    this.end = end;
  }
  DecodingContext.prototype = {
    get decoder() {
      var decoder = new ArithmeticDecoder(this.data, this.start, this.end);
      return shadow(this, 'decoder', decoder);
    },
    get contextCache() {
      var cache = new ContextCache();
      return shadow(this, 'contextCache', cache);
    }
  };
  function decodeInteger(contextCache, procedure, decoder) {
    var contexts = contextCache.getContexts(procedure);
    var prev = 1;
    function readBits(length) {
      var v = 0;
      for (var i = 0; i < length; i++) {
        var bit = decoder.readBit(contexts, prev);
        prev = prev < 256 ? prev << 1 | bit : (prev << 1 | bit) & 511 | 256;
        v = v << 1 | bit;
      }
      return v >>> 0;
    }
    var sign = readBits(1);
    var value = readBits(1) ? readBits(1) ? readBits(1) ? readBits(1) ? readBits(1) ? readBits(32) + 4436 : readBits(12) + 340 : readBits(8) + 84 : readBits(6) + 20 : readBits(4) + 4 : readBits(2);
    return sign === 0 ? value : value > 0 ? -value : null;
  }
  function decodeIAID(contextCache, decoder, codeLength) {
    var contexts = contextCache.getContexts('IAID');
    var prev = 1;
    for (var i = 0; i < codeLength; i++) {
      var bit = decoder.readBit(contexts, prev);
      prev = prev << 1 | bit;
    }
    if (codeLength < 31) {
      return prev & (1 << codeLength) - 1;
    }
    return prev & 0x7FFFFFFF;
  }
  var SegmentTypes = ['SymbolDictionary', null, null, null, 'IntermediateTextRegion', null, 'ImmediateTextRegion', 'ImmediateLosslessTextRegion', null, null, null, null, null, null, null, null, 'patternDictionary', null, null, null, 'IntermediateHalftoneRegion', null, 'ImmediateHalftoneRegion', 'ImmediateLosslessHalftoneRegion', null, null, null, null, null, null, null, null, null, null, null, null, 'IntermediateGenericRegion', null, 'ImmediateGenericRegion', 'ImmediateLosslessGenericRegion', 'IntermediateGenericRefinementRegion', null, 'ImmediateGenericRefinementRegion', 'ImmediateLosslessGenericRefinementRegion', null, null, null, null, 'PageInformation', 'EndOfPage', 'EndOfStripe', 'EndOfFile', 'Profiles', 'Tables', null, null, null, null, null, null, null, null, 'Extension'];
  var CodingTemplates = [[{
    x: -1,
    y: -2
  }, {
    x: 0,
    y: -2
  }, {
    x: 1,
    y: -2
  }, {
    x: -2,
    y: -1
  }, {
    x: -1,
    y: -1
  }, {
    x: 0,
    y: -1
  }, {
    x: 1,
    y: -1
  }, {
    x: 2,
    y: -1
  }, {
    x: -4,
    y: 0
  }, {
    x: -3,
    y: 0
  }, {
    x: -2,
    y: 0
  }, {
    x: -1,
    y: 0
  }], [{
    x: -1,
    y: -2
  }, {
    x: 0,
    y: -2
  }, {
    x: 1,
    y: -2
  }, {
    x: 2,
    y: -2
  }, {
    x: -2,
    y: -1
  }, {
    x: -1,
    y: -1
  }, {
    x: 0,
    y: -1
  }, {
    x: 1,
    y: -1
  }, {
    x: 2,
    y: -1
  }, {
    x: -3,
    y: 0
  }, {
    x: -2,
    y: 0
  }, {
    x: -1,
    y: 0
  }], [{
    x: -1,
    y: -2
  }, {
    x: 0,
    y: -2
  }, {
    x: 1,
    y: -2
  }, {
    x: -2,
    y: -1
  }, {
    x: -1,
    y: -1
  }, {
    x: 0,
    y: -1
  }, {
    x: 1,
    y: -1
  }, {
    x: -2,
    y: 0
  }, {
    x: -1,
    y: 0
  }], [{
    x: -3,
    y: -1
  }, {
    x: -2,
    y: -1
  }, {
    x: -1,
    y: -1
  }, {
    x: 0,
    y: -1
  }, {
    x: 1,
    y: -1
  }, {
    x: -4,
    y: 0
  }, {
    x: -3,
    y: 0
  }, {
    x: -2,
    y: 0
  }, {
    x: -1,
    y: 0
  }]];
  var RefinementTemplates = [{
    coding: [{
      x: 0,
      y: -1
    }, {
      x: 1,
      y: -1
    }, {
      x: -1,
      y: 0
    }],
    reference: [{
      x: 0,
      y: -1
    }, {
      x: 1,
      y: -1
    }, {
      x: -1,
      y: 0
    }, {
      x: 0,
      y: 0
    }, {
      x: 1,
      y: 0
    }, {
      x: -1,
      y: 1
    }, {
      x: 0,
      y: 1
    }, {
      x: 1,
      y: 1
    }]
  }, {
    coding: [{
      x: -1,
      y: -1
    }, {
      x: 0,
      y: -1
    }, {
      x: 1,
      y: -1
    }, {
      x: -1,
      y: 0
    }],
    reference: [{
      x: 0,
      y: -1
    }, {
      x: -1,
      y: 0
    }, {
      x: 0,
      y: 0
    }, {
      x: 1,
      y: 0
    }, {
      x: 0,
      y: 1
    }, {
      x: 1,
      y: 1
    }]
  }];
  var ReusedContexts = [0x9B25, 0x0795, 0x00E5, 0x0195];
  var RefinementReusedContexts = [0x0020, 0x0008];
  function decodeBitmapTemplate0(width, height, decodingContext) {
    var decoder = decodingContext.decoder;
    var contexts = decodingContext.contextCache.getContexts('GB');
    var contextLabel,
        i,
        j,
        pixel,
        row,
        row1,
        row2,
        bitmap = [];
    var OLD_PIXEL_MASK = 0x7BF7;
    for (i = 0; i < height; i++) {
      row = bitmap[i] = new Uint8Array(width);
      row1 = i < 1 ? row : bitmap[i - 1];
      row2 = i < 2 ? row : bitmap[i - 2];
      contextLabel = row2[0] << 13 | row2[1] << 12 | row2[2] << 11 | row1[0] << 7 | row1[1] << 6 | row1[2] << 5 | row1[3] << 4;
      for (j = 0; j < width; j++) {
        row[j] = pixel = decoder.readBit(contexts, contextLabel);
        contextLabel = (contextLabel & OLD_PIXEL_MASK) << 1 | (j + 3 < width ? row2[j + 3] << 11 : 0) | (j + 4 < width ? row1[j + 4] << 4 : 0) | pixel;
      }
    }
    return bitmap;
  }
  function decodeBitmap(mmr, width, height, templateIndex, prediction, skip, at, decodingContext) {
    if (mmr) {
      error('JBIG2 error: MMR encoding is not supported');
    }
    if (templateIndex === 0 && !skip && !prediction && at.length === 4 && at[0].x === 3 && at[0].y === -1 && at[1].x === -3 && at[1].y === -1 && at[2].x === 2 && at[2].y === -2 && at[3].x === -2 && at[3].y === -2) {
      return decodeBitmapTemplate0(width, height, decodingContext);
    }
    var useskip = !!skip;
    var template = CodingTemplates[templateIndex].concat(at);
    template.sort(function (a, b) {
      return a.y - b.y || a.x - b.x;
    });
    var templateLength = template.length;
    var templateX = new Int8Array(templateLength);
    var templateY = new Int8Array(templateLength);
    var changingTemplateEntries = [];
    var reuseMask = 0,
        minX = 0,
        maxX = 0,
        minY = 0;
    var c, k;
    for (k = 0; k < templateLength; k++) {
      templateX[k] = template[k].x;
      templateY[k] = template[k].y;
      minX = Math.min(minX, template[k].x);
      maxX = Math.max(maxX, template[k].x);
      minY = Math.min(minY, template[k].y);
      if (k < templateLength - 1 && template[k].y === template[k + 1].y && template[k].x === template[k + 1].x - 1) {
        reuseMask |= 1 << templateLength - 1 - k;
      } else {
        changingTemplateEntries.push(k);
      }
    }
    var changingEntriesLength = changingTemplateEntries.length;
    var changingTemplateX = new Int8Array(changingEntriesLength);
    var changingTemplateY = new Int8Array(changingEntriesLength);
    var changingTemplateBit = new Uint16Array(changingEntriesLength);
    for (c = 0; c < changingEntriesLength; c++) {
      k = changingTemplateEntries[c];
      changingTemplateX[c] = template[k].x;
      changingTemplateY[c] = template[k].y;
      changingTemplateBit[c] = 1 << templateLength - 1 - k;
    }
    var sbb_left = -minX;
    var sbb_top = -minY;
    var sbb_right = width - maxX;
    var pseudoPixelContext = ReusedContexts[templateIndex];
    var row = new Uint8Array(width);
    var bitmap = [];
    var decoder = decodingContext.decoder;
    var contexts = decodingContext.contextCache.getContexts('GB');
    var ltp = 0,
        j,
        i0,
        j0,
        contextLabel = 0,
        bit,
        shift;
    for (var i = 0; i < height; i++) {
      if (prediction) {
        var sltp = decoder.readBit(contexts, pseudoPixelContext);
        ltp ^= sltp;
        if (ltp) {
          bitmap.push(row);
          continue;
        }
      }
      row = new Uint8Array(row);
      bitmap.push(row);
      for (j = 0; j < width; j++) {
        if (useskip && skip[i][j]) {
          row[j] = 0;
          continue;
        }
        if (j >= sbb_left && j < sbb_right && i >= sbb_top) {
          contextLabel = contextLabel << 1 & reuseMask;
          for (k = 0; k < changingEntriesLength; k++) {
            i0 = i + changingTemplateY[k];
            j0 = j + changingTemplateX[k];
            bit = bitmap[i0][j0];
            if (bit) {
              bit = changingTemplateBit[k];
              contextLabel |= bit;
            }
          }
        } else {
          contextLabel = 0;
          shift = templateLength - 1;
          for (k = 0; k < templateLength; k++, shift--) {
            j0 = j + templateX[k];
            if (j0 >= 0 && j0 < width) {
              i0 = i + templateY[k];
              if (i0 >= 0) {
                bit = bitmap[i0][j0];
                if (bit) {
                  contextLabel |= bit << shift;
                }
              }
            }
          }
        }
        var pixel = decoder.readBit(contexts, contextLabel);
        row[j] = pixel;
      }
    }
    return bitmap;
  }
  function decodeRefinement(width, height, templateIndex, referenceBitmap, offsetX, offsetY, prediction, at, decodingContext) {
    var codingTemplate = RefinementTemplates[templateIndex].coding;
    if (templateIndex === 0) {
      codingTemplate = codingTemplate.concat([at[0]]);
    }
    var codingTemplateLength = codingTemplate.length;
    var codingTemplateX = new Int32Array(codingTemplateLength);
    var codingTemplateY = new Int32Array(codingTemplateLength);
    var k;
    for (k = 0; k < codingTemplateLength; k++) {
      codingTemplateX[k] = codingTemplate[k].x;
      codingTemplateY[k] = codingTemplate[k].y;
    }
    var referenceTemplate = RefinementTemplates[templateIndex].reference;
    if (templateIndex === 0) {
      referenceTemplate = referenceTemplate.concat([at[1]]);
    }
    var referenceTemplateLength = referenceTemplate.length;
    var referenceTemplateX = new Int32Array(referenceTemplateLength);
    var referenceTemplateY = new Int32Array(referenceTemplateLength);
    for (k = 0; k < referenceTemplateLength; k++) {
      referenceTemplateX[k] = referenceTemplate[k].x;
      referenceTemplateY[k] = referenceTemplate[k].y;
    }
    var referenceWidth = referenceBitmap[0].length;
    var referenceHeight = referenceBitmap.length;
    var pseudoPixelContext = RefinementReusedContexts[templateIndex];
    var bitmap = [];
    var decoder = decodingContext.decoder;
    var contexts = decodingContext.contextCache.getContexts('GR');
    var ltp = 0;
    for (var i = 0; i < height; i++) {
      if (prediction) {
        var sltp = decoder.readBit(contexts, pseudoPixelContext);
        ltp ^= sltp;
        if (ltp) {
          error('JBIG2 error: prediction is not supported');
        }
      }
      var row = new Uint8Array(width);
      bitmap.push(row);
      for (var j = 0; j < width; j++) {
        var i0, j0;
        var contextLabel = 0;
        for (k = 0; k < codingTemplateLength; k++) {
          i0 = i + codingTemplateY[k];
          j0 = j + codingTemplateX[k];
          if (i0 < 0 || j0 < 0 || j0 >= width) {
            contextLabel <<= 1;
          } else {
            contextLabel = contextLabel << 1 | bitmap[i0][j0];
          }
        }
        for (k = 0; k < referenceTemplateLength; k++) {
          i0 = i + referenceTemplateY[k] + offsetY;
          j0 = j + referenceTemplateX[k] + offsetX;
          if (i0 < 0 || i0 >= referenceHeight || j0 < 0 || j0 >= referenceWidth) {
            contextLabel <<= 1;
          } else {
            contextLabel = contextLabel << 1 | referenceBitmap[i0][j0];
          }
        }
        var pixel = decoder.readBit(contexts, contextLabel);
        row[j] = pixel;
      }
    }
    return bitmap;
  }
  function decodeSymbolDictionary(huffman, refinement, symbols, numberOfNewSymbols, numberOfExportedSymbols, huffmanTables, templateIndex, at, refinementTemplateIndex, refinementAt, decodingContext) {
    if (huffman) {
      error('JBIG2 error: huffman is not supported');
    }
    var newSymbols = [];
    var currentHeight = 0;
    var symbolCodeLength = log2(symbols.length + numberOfNewSymbols);
    var decoder = decodingContext.decoder;
    var contextCache = decodingContext.contextCache;
    while (newSymbols.length < numberOfNewSymbols) {
      var deltaHeight = decodeInteger(contextCache, 'IADH', decoder);
      currentHeight += deltaHeight;
      var currentWidth = 0;
      while (true) {
        var deltaWidth = decodeInteger(contextCache, 'IADW', decoder);
        if (deltaWidth === null) {
          break;
        }
        currentWidth += deltaWidth;
        var bitmap;
        if (refinement) {
          var numberOfInstances = decodeInteger(contextCache, 'IAAI', decoder);
          if (numberOfInstances > 1) {
            bitmap = decodeTextRegion(huffman, refinement, currentWidth, currentHeight, 0, numberOfInstances, 1, symbols.concat(newSymbols), symbolCodeLength, 0, 0, 1, 0, huffmanTables, refinementTemplateIndex, refinementAt, decodingContext);
          } else {
            var symbolId = decodeIAID(contextCache, decoder, symbolCodeLength);
            var rdx = decodeInteger(contextCache, 'IARDX', decoder);
            var rdy = decodeInteger(contextCache, 'IARDY', decoder);
            var symbol = symbolId < symbols.length ? symbols[symbolId] : newSymbols[symbolId - symbols.length];
            bitmap = decodeRefinement(currentWidth, currentHeight, refinementTemplateIndex, symbol, rdx, rdy, false, refinementAt, decodingContext);
          }
        } else {
          bitmap = decodeBitmap(false, currentWidth, currentHeight, templateIndex, false, null, at, decodingContext);
        }
        newSymbols.push(bitmap);
      }
    }
    var exportedSymbols = [];
    var flags = [],
        currentFlag = false;
    var totalSymbolsLength = symbols.length + numberOfNewSymbols;
    while (flags.length < totalSymbolsLength) {
      var runLength = decodeInteger(contextCache, 'IAEX', decoder);
      while (runLength--) {
        flags.push(currentFlag);
      }
      currentFlag = !currentFlag;
    }
    for (var i = 0, ii = symbols.length; i < ii; i++) {
      if (flags[i]) {
        exportedSymbols.push(symbols[i]);
      }
    }
    for (var j = 0; j < numberOfNewSymbols; i++, j++) {
      if (flags[i]) {
        exportedSymbols.push(newSymbols[j]);
      }
    }
    return exportedSymbols;
  }
  function decodeTextRegion(huffman, refinement, width, height, defaultPixelValue, numberOfSymbolInstances, stripSize, inputSymbols, symbolCodeLength, transposed, dsOffset, referenceCorner, combinationOperator, huffmanTables, refinementTemplateIndex, refinementAt, decodingContext) {
    if (huffman) {
      error('JBIG2 error: huffman is not supported');
    }
    var bitmap = [];
    var i, row;
    for (i = 0; i < height; i++) {
      row = new Uint8Array(width);
      if (defaultPixelValue) {
        for (var j = 0; j < width; j++) {
          row[j] = defaultPixelValue;
        }
      }
      bitmap.push(row);
    }
    var decoder = decodingContext.decoder;
    var contextCache = decodingContext.contextCache;
    var stripT = -decodeInteger(contextCache, 'IADT', decoder);
    var firstS = 0;
    i = 0;
    while (i < numberOfSymbolInstances) {
      var deltaT = decodeInteger(contextCache, 'IADT', decoder);
      stripT += deltaT;
      var deltaFirstS = decodeInteger(contextCache, 'IAFS', decoder);
      firstS += deltaFirstS;
      var currentS = firstS;
      do {
        var currentT = stripSize === 1 ? 0 : decodeInteger(contextCache, 'IAIT', decoder);
        var t = stripSize * stripT + currentT;
        var symbolId = decodeIAID(contextCache, decoder, symbolCodeLength);
        var applyRefinement = refinement && decodeInteger(contextCache, 'IARI', decoder);
        var symbolBitmap = inputSymbols[symbolId];
        var symbolWidth = symbolBitmap[0].length;
        var symbolHeight = symbolBitmap.length;
        if (applyRefinement) {
          var rdw = decodeInteger(contextCache, 'IARDW', decoder);
          var rdh = decodeInteger(contextCache, 'IARDH', decoder);
          var rdx = decodeInteger(contextCache, 'IARDX', decoder);
          var rdy = decodeInteger(contextCache, 'IARDY', decoder);
          symbolWidth += rdw;
          symbolHeight += rdh;
          symbolBitmap = decodeRefinement(symbolWidth, symbolHeight, refinementTemplateIndex, symbolBitmap, (rdw >> 1) + rdx, (rdh >> 1) + rdy, false, refinementAt, decodingContext);
        }
        var offsetT = t - (referenceCorner & 1 ? 0 : symbolHeight);
        var offsetS = currentS - (referenceCorner & 2 ? symbolWidth : 0);
        var s2, t2, symbolRow;
        if (transposed) {
          for (s2 = 0; s2 < symbolHeight; s2++) {
            row = bitmap[offsetS + s2];
            if (!row) {
              continue;
            }
            symbolRow = symbolBitmap[s2];
            var maxWidth = Math.min(width - offsetT, symbolWidth);
            switch (combinationOperator) {
              case 0:
                for (t2 = 0; t2 < maxWidth; t2++) {
                  row[offsetT + t2] |= symbolRow[t2];
                }
                break;
              case 2:
                for (t2 = 0; t2 < maxWidth; t2++) {
                  row[offsetT + t2] ^= symbolRow[t2];
                }
                break;
              default:
                error('JBIG2 error: operator ' + combinationOperator + ' is not supported');
            }
          }
          currentS += symbolHeight - 1;
        } else {
          for (t2 = 0; t2 < symbolHeight; t2++) {
            row = bitmap[offsetT + t2];
            if (!row) {
              continue;
            }
            symbolRow = symbolBitmap[t2];
            switch (combinationOperator) {
              case 0:
                for (s2 = 0; s2 < symbolWidth; s2++) {
                  row[offsetS + s2] |= symbolRow[s2];
                }
                break;
              case 2:
                for (s2 = 0; s2 < symbolWidth; s2++) {
                  row[offsetS + s2] ^= symbolRow[s2];
                }
                break;
              default:
                error('JBIG2 error: operator ' + combinationOperator + ' is not supported');
            }
          }
          currentS += symbolWidth - 1;
        }
        i++;
        var deltaS = decodeInteger(contextCache, 'IADS', decoder);
        if (deltaS === null) {
          break;
        }
        currentS += deltaS + dsOffset;
      } while (true);
    }
    return bitmap;
  }
  function readSegmentHeader(data, start) {
    var segmentHeader = {};
    segmentHeader.number = readUint32(data, start);
    var flags = data[start + 4];
    var segmentType = flags & 0x3F;
    if (!SegmentTypes[segmentType]) {
      error('JBIG2 error: invalid segment type: ' + segmentType);
    }
    segmentHeader.type = segmentType;
    segmentHeader.typeName = SegmentTypes[segmentType];
    segmentHeader.deferredNonRetain = !!(flags & 0x80);
    var pageAssociationFieldSize = !!(flags & 0x40);
    var referredFlags = data[start + 5];
    var referredToCount = referredFlags >> 5 & 7;
    var retainBits = [referredFlags & 31];
    var position = start + 6;
    if (referredFlags === 7) {
      referredToCount = readUint32(data, position - 1) & 0x1FFFFFFF;
      position += 3;
      var bytes = referredToCount + 7 >> 3;
      retainBits[0] = data[position++];
      while (--bytes > 0) {
        retainBits.push(data[position++]);
      }
    } else if (referredFlags === 5 || referredFlags === 6) {
      error('JBIG2 error: invalid referred-to flags');
    }
    segmentHeader.retainBits = retainBits;
    var referredToSegmentNumberSize = segmentHeader.number <= 256 ? 1 : segmentHeader.number <= 65536 ? 2 : 4;
    var referredTo = [];
    var i, ii;
    for (i = 0; i < referredToCount; i++) {
      var number = referredToSegmentNumberSize === 1 ? data[position] : referredToSegmentNumberSize === 2 ? readUint16(data, position) : readUint32(data, position);
      referredTo.push(number);
      position += referredToSegmentNumberSize;
    }
    segmentHeader.referredTo = referredTo;
    if (!pageAssociationFieldSize) {
      segmentHeader.pageAssociation = data[position++];
    } else {
      segmentHeader.pageAssociation = readUint32(data, position);
      position += 4;
    }
    segmentHeader.length = readUint32(data, position);
    position += 4;
    if (segmentHeader.length === 0xFFFFFFFF) {
      if (segmentType === 38) {
        var genericRegionInfo = readRegionSegmentInformation(data, position);
        var genericRegionSegmentFlags = data[position + RegionSegmentInformationFieldLength];
        var genericRegionMmr = !!(genericRegionSegmentFlags & 1);
        var searchPatternLength = 6;
        var searchPattern = new Uint8Array(searchPatternLength);
        if (!genericRegionMmr) {
          searchPattern[0] = 0xFF;
          searchPattern[1] = 0xAC;
        }
        searchPattern[2] = genericRegionInfo.height >>> 24 & 0xFF;
        searchPattern[3] = genericRegionInfo.height >> 16 & 0xFF;
        searchPattern[4] = genericRegionInfo.height >> 8 & 0xFF;
        searchPattern[5] = genericRegionInfo.height & 0xFF;
        for (i = position, ii = data.length; i < ii; i++) {
          var j = 0;
          while (j < searchPatternLength && searchPattern[j] === data[i + j]) {
            j++;
          }
          if (j === searchPatternLength) {
            segmentHeader.length = i + searchPatternLength;
            break;
          }
        }
        if (segmentHeader.length === 0xFFFFFFFF) {
          error('JBIG2 error: segment end was not found');
        }
      } else {
        error('JBIG2 error: invalid unknown segment length');
      }
    }
    segmentHeader.headerEnd = position;
    return segmentHeader;
  }
  function readSegments(header, data, start, end) {
    var segments = [];
    var position = start;
    while (position < end) {
      var segmentHeader = readSegmentHeader(data, position);
      position = segmentHeader.headerEnd;
      var segment = {
        header: segmentHeader,
        data: data
      };
      if (!header.randomAccess) {
        segment.start = position;
        position += segmentHeader.length;
        segment.end = position;
      }
      segments.push(segment);
      if (segmentHeader.type === 51) {
        break;
      }
    }
    if (header.randomAccess) {
      for (var i = 0, ii = segments.length; i < ii; i++) {
        segments[i].start = position;
        position += segments[i].header.length;
        segments[i].end = position;
      }
    }
    return segments;
  }
  function readRegionSegmentInformation(data, start) {
    return {
      width: readUint32(data, start),
      height: readUint32(data, start + 4),
      x: readUint32(data, start + 8),
      y: readUint32(data, start + 12),
      combinationOperator: data[start + 16] & 7
    };
  }
  var RegionSegmentInformationFieldLength = 17;
  function processSegment(segment, visitor) {
    var header = segment.header;
    var data = segment.data,
        position = segment.start,
        end = segment.end;
    var args, at, i, atLength;
    switch (header.type) {
      case 0:
        var dictionary = {};
        var dictionaryFlags = readUint16(data, position);
        dictionary.huffman = !!(dictionaryFlags & 1);
        dictionary.refinement = !!(dictionaryFlags & 2);
        dictionary.huffmanDHSelector = dictionaryFlags >> 2 & 3;
        dictionary.huffmanDWSelector = dictionaryFlags >> 4 & 3;
        dictionary.bitmapSizeSelector = dictionaryFlags >> 6 & 1;
        dictionary.aggregationInstancesSelector = dictionaryFlags >> 7 & 1;
        dictionary.bitmapCodingContextUsed = !!(dictionaryFlags & 256);
        dictionary.bitmapCodingContextRetained = !!(dictionaryFlags & 512);
        dictionary.template = dictionaryFlags >> 10 & 3;
        dictionary.refinementTemplate = dictionaryFlags >> 12 & 1;
        position += 2;
        if (!dictionary.huffman) {
          atLength = dictionary.template === 0 ? 4 : 1;
          at = [];
          for (i = 0; i < atLength; i++) {
            at.push({
              x: readInt8(data, position),
              y: readInt8(data, position + 1)
            });
            position += 2;
          }
          dictionary.at = at;
        }
        if (dictionary.refinement && !dictionary.refinementTemplate) {
          at = [];
          for (i = 0; i < 2; i++) {
            at.push({
              x: readInt8(data, position),
              y: readInt8(data, position + 1)
            });
            position += 2;
          }
          dictionary.refinementAt = at;
        }
        dictionary.numberOfExportedSymbols = readUint32(data, position);
        position += 4;
        dictionary.numberOfNewSymbols = readUint32(data, position);
        position += 4;
        args = [dictionary, header.number, header.referredTo, data, position, end];
        break;
      case 6:
      case 7:
        var textRegion = {};
        textRegion.info = readRegionSegmentInformation(data, position);
        position += RegionSegmentInformationFieldLength;
        var textRegionSegmentFlags = readUint16(data, position);
        position += 2;
        textRegion.huffman = !!(textRegionSegmentFlags & 1);
        textRegion.refinement = !!(textRegionSegmentFlags & 2);
        textRegion.stripSize = 1 << (textRegionSegmentFlags >> 2 & 3);
        textRegion.referenceCorner = textRegionSegmentFlags >> 4 & 3;
        textRegion.transposed = !!(textRegionSegmentFlags & 64);
        textRegion.combinationOperator = textRegionSegmentFlags >> 7 & 3;
        textRegion.defaultPixelValue = textRegionSegmentFlags >> 9 & 1;
        textRegion.dsOffset = textRegionSegmentFlags << 17 >> 27;
        textRegion.refinementTemplate = textRegionSegmentFlags >> 15 & 1;
        if (textRegion.huffman) {
          var textRegionHuffmanFlags = readUint16(data, position);
          position += 2;
          textRegion.huffmanFS = textRegionHuffmanFlags & 3;
          textRegion.huffmanDS = textRegionHuffmanFlags >> 2 & 3;
          textRegion.huffmanDT = textRegionHuffmanFlags >> 4 & 3;
          textRegion.huffmanRefinementDW = textRegionHuffmanFlags >> 6 & 3;
          textRegion.huffmanRefinementDH = textRegionHuffmanFlags >> 8 & 3;
          textRegion.huffmanRefinementDX = textRegionHuffmanFlags >> 10 & 3;
          textRegion.huffmanRefinementDY = textRegionHuffmanFlags >> 12 & 3;
          textRegion.huffmanRefinementSizeSelector = !!(textRegionHuffmanFlags & 14);
        }
        if (textRegion.refinement && !textRegion.refinementTemplate) {
          at = [];
          for (i = 0; i < 2; i++) {
            at.push({
              x: readInt8(data, position),
              y: readInt8(data, position + 1)
            });
            position += 2;
          }
          textRegion.refinementAt = at;
        }
        textRegion.numberOfSymbolInstances = readUint32(data, position);
        position += 4;
        if (textRegion.huffman) {
          error('JBIG2 error: huffman is not supported');
        }
        args = [textRegion, header.referredTo, data, position, end];
        break;
      case 38:
      case 39:
        var genericRegion = {};
        genericRegion.info = readRegionSegmentInformation(data, position);
        position += RegionSegmentInformationFieldLength;
        var genericRegionSegmentFlags = data[position++];
        genericRegion.mmr = !!(genericRegionSegmentFlags & 1);
        genericRegion.template = genericRegionSegmentFlags >> 1 & 3;
        genericRegion.prediction = !!(genericRegionSegmentFlags & 8);
        if (!genericRegion.mmr) {
          atLength = genericRegion.template === 0 ? 4 : 1;
          at = [];
          for (i = 0; i < atLength; i++) {
            at.push({
              x: readInt8(data, position),
              y: readInt8(data, position + 1)
            });
            position += 2;
          }
          genericRegion.at = at;
        }
        args = [genericRegion, data, position, end];
        break;
      case 48:
        var pageInfo = {
          width: readUint32(data, position),
          height: readUint32(data, position + 4),
          resolutionX: readUint32(data, position + 8),
          resolutionY: readUint32(data, position + 12)
        };
        if (pageInfo.height === 0xFFFFFFFF) {
          delete pageInfo.height;
        }
        var pageSegmentFlags = data[position + 16];
        readUint16(data, position + 17);
        pageInfo.lossless = !!(pageSegmentFlags & 1);
        pageInfo.refinement = !!(pageSegmentFlags & 2);
        pageInfo.defaultPixelValue = pageSegmentFlags >> 2 & 1;
        pageInfo.combinationOperator = pageSegmentFlags >> 3 & 3;
        pageInfo.requiresBuffer = !!(pageSegmentFlags & 32);
        pageInfo.combinationOperatorOverride = !!(pageSegmentFlags & 64);
        args = [pageInfo];
        break;
      case 49:
        break;
      case 50:
        break;
      case 51:
        break;
      case 62:
        break;
      default:
        error('JBIG2 error: segment type ' + header.typeName + '(' + header.type + ') is not implemented');
    }
    var callbackName = 'on' + header.typeName;
    if (callbackName in visitor) {
      visitor[callbackName].apply(visitor, args);
    }
  }
  function processSegments(segments, visitor) {
    for (var i = 0, ii = segments.length; i < ii; i++) {
      processSegment(segments[i], visitor);
    }
  }
  function parseJbig2(data, start, end) {
    var position = start;
    if (data[position] !== 0x97 || data[position + 1] !== 0x4A || data[position + 2] !== 0x42 || data[position + 3] !== 0x32 || data[position + 4] !== 0x0D || data[position + 5] !== 0x0A || data[position + 6] !== 0x1A || data[position + 7] !== 0x0A) {
      error('JBIG2 error: invalid header');
    }
    var header = {};
    position += 8;
    var flags = data[position++];
    header.randomAccess = !(flags & 1);
    if (!(flags & 2)) {
      header.numberOfPages = readUint32(data, position);
      position += 4;
    }
    readSegments(header, data, position, end);
    error('Not implemented');
  }
  function parseJbig2Chunks(chunks) {
    var visitor = new SimpleSegmentVisitor();
    for (var i = 0, ii = chunks.length; i < ii; i++) {
      var chunk = chunks[i];
      var segments = readSegments({}, chunk.data, chunk.start, chunk.end);
      processSegments(segments, visitor);
    }
    return visitor.buffer;
  }
  function SimpleSegmentVisitor() {}
  SimpleSegmentVisitor.prototype = {
    onPageInformation: function SimpleSegmentVisitor_onPageInformation(info) {
      this.currentPageInfo = info;
      var rowSize = info.width + 7 >> 3;
      var buffer = new Uint8Array(rowSize * info.height);
      if (info.defaultPixelValue) {
        for (var i = 0, ii = buffer.length; i < ii; i++) {
          buffer[i] = 0xFF;
        }
      }
      this.buffer = buffer;
    },
    drawBitmap: function SimpleSegmentVisitor_drawBitmap(regionInfo, bitmap) {
      var pageInfo = this.currentPageInfo;
      var width = regionInfo.width,
          height = regionInfo.height;
      var rowSize = pageInfo.width + 7 >> 3;
      var combinationOperator = pageInfo.combinationOperatorOverride ? regionInfo.combinationOperator : pageInfo.combinationOperator;
      var buffer = this.buffer;
      var mask0 = 128 >> (regionInfo.x & 7);
      var offset0 = regionInfo.y * rowSize + (regionInfo.x >> 3);
      var i, j, mask, offset;
      switch (combinationOperator) {
        case 0:
          for (i = 0; i < height; i++) {
            mask = mask0;
            offset = offset0;
            for (j = 0; j < width; j++) {
              if (bitmap[i][j]) {
                buffer[offset] |= mask;
              }
              mask >>= 1;
              if (!mask) {
                mask = 128;
                offset++;
              }
            }
            offset0 += rowSize;
          }
          break;
        case 2:
          for (i = 0; i < height; i++) {
            mask = mask0;
            offset = offset0;
            for (j = 0; j < width; j++) {
              if (bitmap[i][j]) {
                buffer[offset] ^= mask;
              }
              mask >>= 1;
              if (!mask) {
                mask = 128;
                offset++;
              }
            }
            offset0 += rowSize;
          }
          break;
        default:
          error('JBIG2 error: operator ' + combinationOperator + ' is not supported');
      }
    },
    onImmediateGenericRegion: function SimpleSegmentVisitor_onImmediateGenericRegion(region, data, start, end) {
      var regionInfo = region.info;
      var decodingContext = new DecodingContext(data, start, end);
      var bitmap = decodeBitmap(region.mmr, regionInfo.width, regionInfo.height, region.template, region.prediction, null, region.at, decodingContext);
      this.drawBitmap(regionInfo, bitmap);
    },
    onImmediateLosslessGenericRegion: function SimpleSegmentVisitor_onImmediateLosslessGenericRegion() {
      this.onImmediateGenericRegion.apply(this, arguments);
    },
    onSymbolDictionary: function SimpleSegmentVisitor_onSymbolDictionary(dictionary, currentSegment, referredSegments, data, start, end) {
      var huffmanTables;
      if (dictionary.huffman) {
        error('JBIG2 error: huffman is not supported');
      }
      var symbols = this.symbols;
      if (!symbols) {
        this.symbols = symbols = {};
      }
      var inputSymbols = [];
      for (var i = 0, ii = referredSegments.length; i < ii; i++) {
        inputSymbols = inputSymbols.concat(symbols[referredSegments[i]]);
      }
      var decodingContext = new DecodingContext(data, start, end);
      symbols[currentSegment] = decodeSymbolDictionary(dictionary.huffman, dictionary.refinement, inputSymbols, dictionary.numberOfNewSymbols, dictionary.numberOfExportedSymbols, huffmanTables, dictionary.template, dictionary.at, dictionary.refinementTemplate, dictionary.refinementAt, decodingContext);
    },
    onImmediateTextRegion: function SimpleSegmentVisitor_onImmediateTextRegion(region, referredSegments, data, start, end) {
      var regionInfo = region.info;
      var huffmanTables;
      var symbols = this.symbols;
      var inputSymbols = [];
      for (var i = 0, ii = referredSegments.length; i < ii; i++) {
        inputSymbols = inputSymbols.concat(symbols[referredSegments[i]]);
      }
      var symbolCodeLength = log2(inputSymbols.length);
      var decodingContext = new DecodingContext(data, start, end);
      var bitmap = decodeTextRegion(region.huffman, region.refinement, regionInfo.width, regionInfo.height, region.defaultPixelValue, region.numberOfSymbolInstances, region.stripSize, inputSymbols, symbolCodeLength, region.transposed, region.dsOffset, region.referenceCorner, region.combinationOperator, huffmanTables, region.refinementTemplate, region.refinementAt, decodingContext);
      this.drawBitmap(regionInfo, bitmap);
    },
    onImmediateLosslessTextRegion: function SimpleSegmentVisitor_onImmediateLosslessTextRegion() {
      this.onImmediateTextRegion.apply(this, arguments);
    }
  };
  function Jbig2Image() {}
  Jbig2Image.prototype = {
    parseChunks: function Jbig2Image_parseChunks(chunks) {
      return parseJbig2Chunks(chunks);
    }
  };
  return Jbig2Image;
}();


	
	
	
	function log2(x) {
        var n = 1, i = 0;
        while (x > n) {
            n <<= 1;
            i++;
        }
        return i;
    }
    function readInt8(data, start) {
        return data[start] << 24 >> 24;
    }
    function readUint16(data, offset) {
        return data[offset] << 8 | data[offset + 1];
    }
    function readUint32(data, offset) {
        return (data[offset] << 24 | data[offset + 1] << 16 | data[offset + 2] << 8 | data[offset + 3]) >>> 0;
    }
    function shadow(obj, prop, value) {
        Object.defineProperty(obj, prop, {
            value: value,
            enumerable: true,
            configurable: true,
            writable: false
        });
        return value;
    }
    var error = function() {
        console.error.apply(console, arguments);
        throw new Error("PDFJS error: " + arguments[0]);
    };
    var warn = function() {
        console.warn.apply(console, arguments);
    };
    var info = function() {
        console.info.apply(console, arguments);
    };
    Jbig2Image.prototype.parse = function parseJbig2(data) {
        var position = 0, end = data.length;
        if (data[position] !== 151 || data[position + 1] !== 74 || data[position + 2] !== 66 || data[position + 3] !== 50 || data[position + 4] !== 13 || data[position + 5] !== 10 || data[position + 6] !== 26 || data[position + 7] !== 10) {
            error("JBIG2 error: invalid header");
        }
        var header = {};
        position += 8;
        var flags = data[position++];
        header.randomAccess = !(flags & 1);
        if (!(flags & 2)) {
            header.numberOfPages = readUint32(data, position);
            position += 4;
        }
        var visitor = this.parseChunks([ {
            data: data,
            start: position,
            end: end
        } ]);
        var width = visitor.currentPageInfo.width;
        var height = visitor.currentPageInfo.height;
        var bitPacked = visitor.buffer;
        var data = new Uint8Array(width * height);
        var q = 0, k = 0;
        for (var i = 0; i < height; i++) {
            var mask = 0, buffer;
            for (var j = 0; j < width; j++) {
                if (!mask) {
                    mask = 128;
                    buffer = bitPacked[k++];
                }
                data[q++] = buffer & mask ? 0 : 255;
                mask >>= 1;
            }
        }
        this.width = width;
        this.height = height;
        this.data = data;
    };
    PDFJS.JpegImage = JpegImage;
    PDFJS.JpxImage = JpxImage;
    PDFJS.Jbig2Image = Jbig2Image;
})(PDFJS || (PDFJS = {}));

var JpegDecoder = PDFJS.JpegImage;

var JpxDecoder = PDFJS.JpxImage;

var Jbig2Decoder = PDFJS.Jbig2Image;(function(r){"object"===typeof exports&&"undefined"!==typeof module?module.exports=r():"function"===typeof define&&define.amd?define([],r):("undefined"!==typeof window?window:"undefined"!==typeof global?global:"undefined"!==typeof self?self:this).acorn=r()})(function(){return function a(l,f,c){function g(d,n){if(!f[d]){if(!l[d]){var e="function"==typeof require&&require;if(!n&&e)return e(d,!0);if(b)return b(d,!0);e=Error("Cannot find module '"+d+"'");throw e.code="MODULE_NOT_FOUND",e;}e=f[d]={exports:{}};
l[d][0].call(e.exports,function(b){var e=l[d][1][b];return g(e?e:b)},e,e.exports,a,l,f,c)}return f[d].exports}for(var b="function"==typeof require&&require,d=0;d<c.length;d++)g(c[d]);return g}({1:[function(a,l,f){var c=a("./tokentype");a=a("./state").Parser.prototype;a.checkPropClash=function(b,c){if(!(6<=this.options.ecmaVersion&&(b.computed||b.method||b.shorthand))){var d=b.key;switch(d.type){case "Identifier":var a=d.name;break;case "Literal":a=String(d.value);break;default:return}var e=b.kind;
if(6<=this.options.ecmaVersion)"__proto__"===a&&"init"===e&&(c.proto&&this.raiseRecoverable(d.start,"Redefinition of __proto__ property"),c.proto=!0);else{a="$"+a;var m=c[a];m?(a="init"!==e,(!this.strict&&!a||!m[e])&&a^m.init||this.raiseRecoverable(d.start,"Redefinition of property")):m=c[a]={init:!1,get:!1,set:!1};m[e]=!0}}};a.parseExpression=function(b,a){var d=this.start,n=this.startLoc,e=this.parseMaybeAssign(b,a);if(this.type===c.types.comma){d=this.startNodeAt(d,n);for(d.expressions=[e];this.eat(c.types.comma);)d.expressions.push(this.parseMaybeAssign(b,
a));return this.finishNode(d,"SequenceExpression")}return e};a.parseMaybeAssign=function(b,a,h){if(this.inGenerator&&this.isContextual("yield"))return this.parseYield();var d=!1;a||(a={shorthandAssign:0,trailingComma:0},d=!0);var e=this.start,m=this.startLoc;if(this.type==c.types.parenL||this.type==c.types.name)this.potentialArrowAt=this.start;var p=this.parseMaybeConditional(b,a);h&&(p=h.call(this,p,e,m));if(this.type.isAssign)return d&&this.checkPatternErrors(a,!0),h=this.startNodeAt(e,m),h.operator=
this.value,h.left=this.type===c.types.eq?this.toAssignable(p):p,a.shorthandAssign=0,this.checkLVal(p),this.next(),h.right=this.parseMaybeAssign(b),this.finishNode(h,"AssignmentExpression");d&&this.checkExpressionErrors(a,!0);return p};a.parseMaybeConditional=function(b,a){var d=this.start,n=this.startLoc,e=this.parseExprOps(b,a);return this.checkExpressionErrors(a)?e:this.eat(c.types.question)?(d=this.startNodeAt(d,n),d.test=e,d.consequent=this.parseMaybeAssign(),this.expect(c.types.colon),d.alternate=
this.parseMaybeAssign(b),this.finishNode(d,"ConditionalExpression")):e};a.parseExprOps=function(b,c){var a=this.start,d=this.startLoc,e=this.parseMaybeUnary(c,!1);return this.checkExpressionErrors(c)?e:this.parseExprOp(e,a,d,-1,b)};a.parseExprOp=function(b,a,h,n,e){var d=this.type.binop;if(null!=d&&(!e||this.type!==c.types._in)&&d>n){var p=this.type===c.types.logicalOR||this.type===c.types.logicalAND,g=this.value;this.next();var k=this.start,q=this.startLoc,d=this.parseExprOp(this.parseMaybeUnary(null,
!1),k,q,d,e);b=this.buildBinary(a,h,b,d,g,p);return this.parseExprOp(b,a,h,n,e)}return b};a.buildBinary=function(b,c,a,n,e,m){b=this.startNodeAt(b,c);b.left=a;b.operator=e;b.right=n;return this.finishNode(b,m?"LogicalExpression":"BinaryExpression")};a.parseMaybeUnary=function(b,a){var d=this.start,n=this.startLoc;if(this.type.prefix){var e=this.startNode();var m=this.type===c.types.incDec;e.operator=this.value;e.prefix=!0;this.next();e.argument=this.parseMaybeUnary(null,!0);this.checkExpressionErrors(b,
!0);m?this.checkLVal(e.argument):this.strict&&"delete"===e.operator&&"Identifier"===e.argument.type?this.raiseRecoverable(e.start,"Deleting local variable in strict mode"):a=!0;m=this.finishNode(e,m?"UpdateExpression":"UnaryExpression")}else{m=this.parseExprSubscripts(b);if(this.checkExpressionErrors(b))return m;for(;this.type.postfix&&!this.canInsertSemicolon();)e=this.startNodeAt(d,n),e.operator=this.value,e.prefix=!1,e.argument=m,this.checkLVal(m),this.next(),m=this.finishNode(e,"UpdateExpression")}return!a&&
this.eat(c.types.starstar)?this.buildBinary(d,n,m,this.parseMaybeUnary(null,!1),"**",!1):m};a.parseExprSubscripts=function(b){var c=this.start,a=this.startLoc,n=this.parseExprAtom(b),e="ArrowFunctionExpression"===n.type&&")"!==this.input.slice(this.lastTokStart,this.lastTokEnd);return this.checkExpressionErrors(b)||e?n:this.parseSubscripts(n,c,a)};a.parseSubscripts=function(b,a,h,n){for(var e;;)if(this.eat(c.types.dot))e=this.startNodeAt(a,h),e.object=b,e.property=this.parseIdent(!0),e.computed=!1,
b=this.finishNode(e,"MemberExpression");else if(this.eat(c.types.bracketL))e=this.startNodeAt(a,h),e.object=b,e.property=this.parseExpression(),e.computed=!0,this.expect(c.types.bracketR),b=this.finishNode(e,"MemberExpression");else if(!n&&this.eat(c.types.parenL))e=this.startNodeAt(a,h),e.callee=b,e.arguments=this.parseExprList(c.types.parenR,!1),b=this.finishNode(e,"CallExpression");else if(this.type===c.types.backQuote)e=this.startNodeAt(a,h),e.tag=b,e.quasi=this.parseTemplate(),b=this.finishNode(e,
"TaggedTemplateExpression");else return b};a.parseExprAtom=function(b){var a=this.potentialArrowAt==this.start;switch(this.type){case c.types._super:this.inFunction||this.raise(this.start,"'super' outside of function or class");case c.types._this:return b=this.type===c.types._this?"ThisExpression":"Super",a=this.startNode(),this.next(),this.finishNode(a,b);case c.types.name:b=this.start;var h=this.startLoc,n=this.parseIdent(this.type!==c.types.name);return a&&!this.canInsertSemicolon()&&this.eat(c.types.arrow)?
this.parseArrowExpression(this.startNodeAt(b,h),[n]):n;case c.types.regexp:return b=this.value,a=this.parseLiteral(b.value),a.regex={pattern:b.pattern,flags:b.flags},a;case c.types.num:case c.types.string:return this.parseLiteral(this.value);case c.types._null:case c.types._true:case c.types._false:return a=this.startNode(),a.value=this.type===c.types._null?null:this.type===c.types._true,a.raw=this.type.keyword,this.next(),this.finishNode(a,"Literal");case c.types.parenL:return this.parseParenAndDistinguishExpression(a);
case c.types.bracketL:return a=this.startNode(),this.next(),a.elements=this.parseExprList(c.types.bracketR,!0,!0,b),this.finishNode(a,"ArrayExpression");case c.types.braceL:return this.parseObj(!1,b);case c.types._function:return a=this.startNode(),this.next(),this.parseFunction(a,!1);case c.types._class:return this.parseClass(this.startNode(),!1);case c.types._new:return this.parseNew();case c.types.backQuote:return this.parseTemplate();default:this.unexpected()}};a.parseLiteral=function(b){var a=
this.startNode();a.value=b;a.raw=this.input.slice(this.start,this.end);this.next();return this.finishNode(a,"Literal")};a.parseParenExpression=function(){this.expect(c.types.parenL);var b=this.parseExpression();this.expect(c.types.parenR);return b};a.parseParenAndDistinguishExpression=function(b){var a=this.start,h=this.startLoc;if(6<=this.options.ecmaVersion){this.next();for(var n=this.start,e=this.startLoc,m=[],p=!0,g={shorthandAssign:0,trailingComma:0},k=void 0,q=void 0;this.type!==c.types.parenR;)if(p?
p=!1:this.expect(c.types.comma),this.type===c.types.ellipsis){k=this.start;m.push(this.parseParenItem(this.parseRest()));break}else this.type!==c.types.parenL||q||(q=this.start),m.push(this.parseMaybeAssign(!1,g,this.parseParenItem));var p=this.start,f=this.startLoc;this.expect(c.types.parenR);if(b&&!this.canInsertSemicolon()&&this.eat(c.types.arrow))return this.checkPatternErrors(g,!0),q&&this.unexpected(q),this.parseParenArrowList(a,h,m);m.length||this.unexpected(this.lastTokStart);k&&this.unexpected(k);
this.checkExpressionErrors(g,!0);1<m.length?(b=this.startNodeAt(n,e),b.expressions=m,this.finishNodeAt(b,"SequenceExpression",p,f)):b=m[0]}else b=this.parseParenExpression();return this.options.preserveParens?(a=this.startNodeAt(a,h),a.expression=b,this.finishNode(a,"ParenthesizedExpression")):b};a.parseParenItem=function(b){return b};a.parseParenArrowList=function(b,a,c){return this.parseArrowExpression(this.startNodeAt(b,a),c)};var g=[];a.parseNew=function(){var b=this.startNode(),a=this.parseIdent(!0);
if(6<=this.options.ecmaVersion&&this.eat(c.types.dot))return b.meta=a,b.property=this.parseIdent(!0),"target"!==b.property.name&&this.raiseRecoverable(b.property.start,"The only valid meta property for new is new.target"),this.inFunction||this.raiseRecoverable(b.start,"new.target can only be used in functions"),this.finishNode(b,"MetaProperty");var a=this.start,h=this.startLoc;b.callee=this.parseSubscripts(this.parseExprAtom(),a,h,!0);this.eat(c.types.parenL)?b.arguments=this.parseExprList(c.types.parenR,
!1):b.arguments=g;return this.finishNode(b,"NewExpression")};a.parseTemplateElement=function(){var b=this.startNode();b.value={raw:this.input.slice(this.start,this.end).replace(/\r\n?/g,"\n"),cooked:this.value};this.next();b.tail=this.type===c.types.backQuote;return this.finishNode(b,"TemplateElement")};a.parseTemplate=function(){var b=this.startNode();this.next();b.expressions=[];var a=this.parseTemplateElement();for(b.quasis=[a];!a.tail;)this.expect(c.types.dollarBraceL),b.expressions.push(this.parseExpression()),
this.expect(c.types.braceR),b.quasis.push(a=this.parseTemplateElement());this.next();return this.finishNode(b,"TemplateLiteral")};a.parseObj=function(b,a){var d=this.startNode(),n=!0,e={};d.properties=[];for(this.next();!this.eat(c.types.braceR);){if(n)n=!1;else if(this.expect(c.types.comma),this.afterTrailingComma(c.types.braceR))break;var m=this.startNode(),p=void 0,g=void 0,k=void 0;if(6<=this.options.ecmaVersion){m.method=!1;m.shorthand=!1;if(b||a)g=this.start,k=this.startLoc;b||(p=this.eat(c.types.star))}this.parsePropertyName(m);
this.parsePropertyValue(m,b,p,g,k,a);this.checkPropClash(m,e);d.properties.push(this.finishNode(m,"Property"))}return this.finishNode(d,b?"ObjectPattern":"ObjectExpression")};a.parsePropertyValue=function(b,a,h,n,e,m){this.eat(c.types.colon)?(b.value=a?this.parseMaybeDefault(this.start,this.startLoc):this.parseMaybeAssign(!1,m),b.kind="init"):6<=this.options.ecmaVersion&&this.type===c.types.parenL?(a&&this.unexpected(),b.kind="init",b.method=!0,b.value=this.parseMethod(h)):5<=this.options.ecmaVersion&&
!b.computed&&"Identifier"===b.key.type&&("get"===b.key.name||"set"===b.key.name)&&this.type!=c.types.comma&&this.type!=c.types.braceR?((h||a)&&this.unexpected(),b.kind=b.key.name,this.parsePropertyName(b),b.value=this.parseMethod(!1),b.value.params.length!==("get"===b.kind?0:1)&&(a=b.value.start,"get"===b.kind?this.raiseRecoverable(a,"getter should have no params"):this.raiseRecoverable(a,"setter should have exactly one param")),"set"===b.kind&&"RestElement"===b.value.params[0].type&&this.raiseRecoverable(b.value.params[0].start,
"Setter cannot use rest params")):6<=this.options.ecmaVersion&&!b.computed&&"Identifier"===b.key.type?(b.kind="init",a?((this.keywords.test(b.key.name)||(this.strict?this.reservedWordsStrictBind:this.reservedWords).test(b.key.name)||this.inGenerator&&"yield"==b.key.name)&&this.raiseRecoverable(b.key.start,"Binding "+b.key.name),b.value=this.parseMaybeDefault(n,e,b.key)):this.type===c.types.eq&&m?(m.shorthandAssign||(m.shorthandAssign=this.start),b.value=this.parseMaybeDefault(n,e,b.key)):b.value=
b.key,b.shorthand=!0):this.unexpected()};a.parsePropertyName=function(b){if(6<=this.options.ecmaVersion){if(this.eat(c.types.bracketL))return b.computed=!0,b.key=this.parseMaybeAssign(),this.expect(c.types.bracketR),b.key;b.computed=!1}return b.key=this.type===c.types.num||this.type===c.types.string?this.parseExprAtom():this.parseIdent(!0)};a.initFunction=function(b){b.id=null;6<=this.options.ecmaVersion&&(b.generator=!1,b.expression=!1)};a.parseMethod=function(b){var a=this.startNode(),h=this.inGenerator;
this.inGenerator=b;this.initFunction(a);this.expect(c.types.parenL);a.params=this.parseBindingList(c.types.parenR,!1,!1);6<=this.options.ecmaVersion&&(a.generator=b);this.parseFunctionBody(a,!1);this.inGenerator=h;return this.finishNode(a,"FunctionExpression")};a.parseArrowExpression=function(b,a){var c=this.inGenerator;this.inGenerator=!1;this.initFunction(b);b.params=this.toAssignableList(a,!0);this.parseFunctionBody(b,!0);this.inGenerator=c;return this.finishNode(b,"ArrowFunctionExpression")};
a.parseFunctionBody=function(b,a){var d=a&&this.type!==c.types.braceL;if(d)b.body=this.parseMaybeAssign(),b.expression=!0;else{var n=this.inFunction,e=this.labels;this.inFunction=!0;this.labels=[];b.body=this.parseBlock(!0);b.expression=!1;this.inFunction=n;this.labels=e}this.strict||!d&&b.body.body.length&&this.isUseStrict(b.body.body[0])?(d=this.strict,this.strict=!0,b.id&&this.checkLVal(b.id,!0),this.checkParams(b),this.strict=d):a&&this.checkParams(b)};a.checkParams=function(b){for(var a={},c=
0;c<b.params.length;c++)this.checkLVal(b.params[c],!0,a)};a.parseExprList=function(b,a,h,n){for(var e=[],d=!0;!this.eat(b);){if(d)d=!1;else if(this.expect(c.types.comma),a&&this.afterTrailingComma(b))break;if(h&&this.type===c.types.comma)var p=null;else this.type===c.types.ellipsis?(p=this.parseSpread(n),this.type===c.types.comma&&n&&!n.trailingComma&&(n.trailingComma=this.lastTokStart)):p=this.parseMaybeAssign(!1,n);e.push(p)}return e};a.parseIdent=function(b){var a=this.startNode();b&&"never"==
this.options.allowReserved&&(b=!1);this.type===c.types.name?(!b&&(this.strict?this.reservedWordsStrict:this.reservedWords).test(this.value)&&(6<=this.options.ecmaVersion||-1==this.input.slice(this.start,this.end).indexOf("\\"))&&this.raiseRecoverable(this.start,"The keyword '"+this.value+"' is reserved"),!b&&this.inGenerator&&"yield"===this.value&&this.raiseRecoverable(this.start,"Can not use 'yield' as identifier inside a generator"),a.name=this.value):b&&this.type.keyword?a.name=this.type.keyword:
this.unexpected();this.next();return this.finishNode(a,"Identifier")};a.parseYield=function(){var b=this.startNode();this.next();this.type==c.types.semi||this.canInsertSemicolon()||this.type!=c.types.star&&!this.type.startsExpr?(b.delegate=!1,b.argument=null):(b.delegate=this.eat(c.types.star),b.argument=this.parseMaybeAssign());return this.finishNode(b,"YieldExpression")}},{"./state":10,"./tokentype":14}],2:[function(a,l,f){function c(b,a){for(var e=65536,c=0;c<a.length;c+=2){e+=a[c];if(e>b)return!1;
e+=a[c+1];if(e>=b)return!0}}f.__esModule=!0;f.isIdentifierStart=function(b,a){return 65>b?36===b:91>b?!0:97>b?95===b:123>b?!0:65535>=b?170<=b&&g.test(String.fromCharCode(b)):!1===a?!1:c(b,d)};f.isIdentifierChar=function(a,e){return 48>a?36===a:58>a?!0:65>a?!1:91>a?!0:97>a?95===a:123>a?!0:65535>=a?170<=a&&b.test(String.fromCharCode(a)):!1===e?!1:c(a,d)||c(a,h)};f.reservedWords={3:"abstract boolean byte char class double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile",
5:"class enum extends super const export import",6:"enum",7:"enum",strict:"implements interface let package private protected public static yield",strictBind:"eval arguments"};f.keywords={5:"break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this",6:"break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this const class extends export import super"};
a="\u00aa\u00b5\u00ba\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02c1\u02c6-\u02d1\u02e0-\u02e4\u02ec\u02ee\u0370-\u0374\u0376\u0377\u037a-\u037d\u037f\u0386\u0388-\u038a\u038c\u038e-\u03a1\u03a3-\u03f5\u03f7-\u0481\u048a-\u052f\u0531-\u0556\u0559\u0561-\u0587\u05d0-\u05ea\u05f0-\u05f2\u0620-\u064a\u066e\u066f\u0671-\u06d3\u06d5\u06e5\u06e6\u06ee\u06ef\u06fa-\u06fc\u06ff\u0710\u0712-\u072f\u074d-\u07a5\u07b1\u07ca-\u07ea\u07f4\u07f5\u07fa\u0800-\u0815\u081a\u0824\u0828\u0840-\u0858\u08a0-\u08b4\u0904-\u0939\u093d\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098c\u098f\u0990\u0993-\u09a8\u09aa-\u09b0\u09b2\u09b6-\u09b9\u09bd\u09ce\u09dc\u09dd\u09df-\u09e1\u09f0\u09f1\u0a05-\u0a0a\u0a0f\u0a10\u0a13-\u0a28\u0a2a-\u0a30\u0a32\u0a33\u0a35\u0a36\u0a38\u0a39\u0a59-\u0a5c\u0a5e\u0a72-\u0a74\u0a85-\u0a8d\u0a8f-\u0a91\u0a93-\u0aa8\u0aaa-\u0ab0\u0ab2\u0ab3\u0ab5-\u0ab9\u0abd\u0ad0\u0ae0\u0ae1\u0af9\u0b05-\u0b0c\u0b0f\u0b10\u0b13-\u0b28\u0b2a-\u0b30\u0b32\u0b33\u0b35-\u0b39\u0b3d\u0b5c\u0b5d\u0b5f-\u0b61\u0b71\u0b83\u0b85-\u0b8a\u0b8e-\u0b90\u0b92-\u0b95\u0b99\u0b9a\u0b9c\u0b9e\u0b9f\u0ba3\u0ba4\u0ba8-\u0baa\u0bae-\u0bb9\u0bd0\u0c05-\u0c0c\u0c0e-\u0c10\u0c12-\u0c28\u0c2a-\u0c39\u0c3d\u0c58-\u0c5a\u0c60\u0c61\u0c85-\u0c8c\u0c8e-\u0c90\u0c92-\u0ca8\u0caa-\u0cb3\u0cb5-\u0cb9\u0cbd\u0cde\u0ce0\u0ce1\u0cf1\u0cf2\u0d05-\u0d0c\u0d0e-\u0d10\u0d12-\u0d3a\u0d3d\u0d4e\u0d5f-\u0d61\u0d7a-\u0d7f\u0d85-\u0d96\u0d9a-\u0db1\u0db3-\u0dbb\u0dbd\u0dc0-\u0dc6\u0e01-\u0e30\u0e32\u0e33\u0e40-\u0e46\u0e81\u0e82\u0e84\u0e87\u0e88\u0e8a\u0e8d\u0e94-\u0e97\u0e99-\u0e9f\u0ea1-\u0ea3\u0ea5\u0ea7\u0eaa\u0eab\u0ead-\u0eb0\u0eb2\u0eb3\u0ebd\u0ec0-\u0ec4\u0ec6\u0edc-\u0edf\u0f00\u0f40-\u0f47\u0f49-\u0f6c\u0f88-\u0f8c\u1000-\u102a\u103f\u1050-\u1055\u105a-\u105d\u1061\u1065\u1066\u106e-\u1070\u1075-\u1081\u108e\u10a0-\u10c5\u10c7\u10cd\u10d0-\u10fa\u10fc-\u1248\u124a-\u124d\u1250-\u1256\u1258\u125a-\u125d\u1260-\u1288\u128a-\u128d\u1290-\u12b0\u12b2-\u12b5\u12b8-\u12be\u12c0\u12c2-\u12c5\u12c8-\u12d6\u12d8-\u1310\u1312-\u1315\u1318-\u135a\u1380-\u138f\u13a0-\u13f5\u13f8-\u13fd\u1401-\u166c\u166f-\u167f\u1681-\u169a\u16a0-\u16ea\u16ee-\u16f8\u1700-\u170c\u170e-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176c\u176e-\u1770\u1780-\u17b3\u17d7\u17dc\u1820-\u1877\u1880-\u18a8\u18aa\u18b0-\u18f5\u1900-\u191e\u1950-\u196d\u1970-\u1974\u1980-\u19ab\u19b0-\u19c9\u1a00-\u1a16\u1a20-\u1a54\u1aa7\u1b05-\u1b33\u1b45-\u1b4b\u1b83-\u1ba0\u1bae\u1baf\u1bba-\u1be5\u1c00-\u1c23\u1c4d-\u1c4f\u1c5a-\u1c7d\u1ce9-\u1cec\u1cee-\u1cf1\u1cf5\u1cf6\u1d00-\u1dbf\u1e00-\u1f15\u1f18-\u1f1d\u1f20-\u1f45\u1f48-\u1f4d\u1f50-\u1f57\u1f59\u1f5b\u1f5d\u1f5f-\u1f7d\u1f80-\u1fb4\u1fb6-\u1fbc\u1fbe\u1fc2-\u1fc4\u1fc6-\u1fcc\u1fd0-\u1fd3\u1fd6-\u1fdb\u1fe0-\u1fec\u1ff2-\u1ff4\u1ff6-\u1ffc\u2071\u207f\u2090-\u209c\u2102\u2107\u210a-\u2113\u2115\u2118-\u211d\u2124\u2126\u2128\u212a-\u2139\u213c-\u213f\u2145-\u2149\u214e\u2160-\u2188\u2c00-\u2c2e\u2c30-\u2c5e\u2c60-\u2ce4\u2ceb-\u2cee\u2cf2\u2cf3\u2d00-\u2d25\u2d27\u2d2d\u2d30-\u2d67\u2d6f\u2d80-\u2d96\u2da0-\u2da6\u2da8-\u2dae\u2db0-\u2db6\u2db8-\u2dbe\u2dc0-\u2dc6\u2dc8-\u2dce\u2dd0-\u2dd6\u2dd8-\u2dde\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303c\u3041-\u3096\u309b-\u309f\u30a1-\u30fa\u30fc-\u30ff\u3105-\u312d\u3131-\u318e\u31a0-\u31ba\u31f0-\u31ff\u3400-\u4db5\u4e00-\u9fd5\ua000-\ua48c\ua4d0-\ua4fd\ua500-\ua60c\ua610-\ua61f\ua62a\ua62b\ua640-\ua66e\ua67f-\ua69d\ua6a0-\ua6ef\ua717-\ua71f\ua722-\ua788\ua78b-\ua7ad\ua7b0-\ua7b7\ua7f7-\ua801\ua803-\ua805\ua807-\ua80a\ua80c-\ua822\ua840-\ua873\ua882-\ua8b3\ua8f2-\ua8f7\ua8fb\ua8fd\ua90a-\ua925\ua930-\ua946\ua960-\ua97c\ua984-\ua9b2\ua9cf\ua9e0-\ua9e4\ua9e6-\ua9ef\ua9fa-\ua9fe\uaa00-\uaa28\uaa40-\uaa42\uaa44-\uaa4b\uaa60-\uaa76\uaa7a\uaa7e-\uaaaf\uaab1\uaab5\uaab6\uaab9-\uaabd\uaac0\uaac2\uaadb-\uaadd\uaae0-\uaaea\uaaf2-\uaaf4\uab01-\uab06\uab09-\uab0e\uab11-\uab16\uab20-\uab26\uab28-\uab2e\uab30-\uab5a\uab5c-\uab65\uab70-\uabe2\uac00-\ud7a3\ud7b0-\ud7c6\ud7cb-\ud7fb\uf900-\ufa6d\ufa70-\ufad9\ufb00-\ufb06\ufb13-\ufb17\ufb1d\ufb1f-\ufb28\ufb2a-\ufb36\ufb38-\ufb3c\ufb3e\ufb40\ufb41\ufb43\ufb44\ufb46-\ufbb1\ufbd3-\ufd3d\ufd50-\ufd8f\ufd92-\ufdc7\ufdf0-\ufdfb\ufe70-\ufe74\ufe76-\ufefc\uff21-\uff3a\uff41-\uff5a\uff66-\uffbe\uffc2-\uffc7\uffca-\uffcf\uffd2-\uffd7\uffda-\uffdc";
var g=new RegExp("["+a+"]"),b=new RegExp("["+a+"\u200c\u200d\u00b7\u0300-\u036f\u0387\u0483-\u0487\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u064b-\u0669\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7\u06e8\u06ea-\u06ed\u06f0-\u06f9\u0711\u0730-\u074a\u07a6-\u07b0\u07c0-\u07c9\u07eb-\u07f3\u0816-\u0819\u081b-\u0823\u0825-\u0827\u0829-\u082d\u0859-\u085b\u08e3-\u0903\u093a-\u093c\u093e-\u094f\u0951-\u0957\u0962\u0963\u0966-\u096f\u0981-\u0983\u09bc\u09be-\u09c4\u09c7\u09c8\u09cb-\u09cd\u09d7\u09e2\u09e3\u09e6-\u09ef\u0a01-\u0a03\u0a3c\u0a3e-\u0a42\u0a47\u0a48\u0a4b-\u0a4d\u0a51\u0a66-\u0a71\u0a75\u0a81-\u0a83\u0abc\u0abe-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd\u0ae2\u0ae3\u0ae6-\u0aef\u0b01-\u0b03\u0b3c\u0b3e-\u0b44\u0b47\u0b48\u0b4b-\u0b4d\u0b56\u0b57\u0b62\u0b63\u0b66-\u0b6f\u0b82\u0bbe-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcd\u0bd7\u0be6-\u0bef\u0c00-\u0c03\u0c3e-\u0c44\u0c46-\u0c48\u0c4a-\u0c4d\u0c55\u0c56\u0c62\u0c63\u0c66-\u0c6f\u0c81-\u0c83\u0cbc\u0cbe-\u0cc4\u0cc6-\u0cc8\u0cca-\u0ccd\u0cd5\u0cd6\u0ce2\u0ce3\u0ce6-\u0cef\u0d01-\u0d03\u0d3e-\u0d44\u0d46-\u0d48\u0d4a-\u0d4d\u0d57\u0d62\u0d63\u0d66-\u0d6f\u0d82\u0d83\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf\u0de6-\u0def\u0df2\u0df3\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\u0e50-\u0e59\u0eb1\u0eb4-\u0eb9\u0ebb\u0ebc\u0ec8-\u0ecd\u0ed0-\u0ed9\u0f18\u0f19\u0f20-\u0f29\u0f35\u0f37\u0f39\u0f3e\u0f3f\u0f71-\u0f84\u0f86\u0f87\u0f8d-\u0f97\u0f99-\u0fbc\u0fc6\u102b-\u103e\u1040-\u1049\u1056-\u1059\u105e-\u1060\u1062-\u1064\u1067-\u106d\u1071-\u1074\u1082-\u108d\u108f-\u109d\u135d-\u135f\u1369-\u1371\u1712-\u1714\u1732-\u1734\u1752\u1753\u1772\u1773\u17b4-\u17d3\u17dd\u17e0-\u17e9\u180b-\u180d\u1810-\u1819\u18a9\u1920-\u192b\u1930-\u193b\u1946-\u194f\u19d0-\u19da\u1a17-\u1a1b\u1a55-\u1a5e\u1a60-\u1a7c\u1a7f-\u1a89\u1a90-\u1a99\u1ab0-\u1abd\u1b00-\u1b04\u1b34-\u1b44\u1b50-\u1b59\u1b6b-\u1b73\u1b80-\u1b82\u1ba1-\u1bad\u1bb0-\u1bb9\u1be6-\u1bf3\u1c24-\u1c37\u1c40-\u1c49\u1c50-\u1c59\u1cd0-\u1cd2\u1cd4-\u1ce8\u1ced\u1cf2-\u1cf4\u1cf8\u1cf9\u1dc0-\u1df5\u1dfc-\u1dff\u203f\u2040\u2054\u20d0-\u20dc\u20e1\u20e5-\u20f0\u2cef-\u2cf1\u2d7f\u2de0-\u2dff\u302a-\u302f\u3099\u309a\ua620-\ua629\ua66f\ua674-\ua67d\ua69e\ua69f\ua6f0\ua6f1\ua802\ua806\ua80b\ua823-\ua827\ua880\ua881\ua8b4-\ua8c4\ua8d0-\ua8d9\ua8e0-\ua8f1\ua900-\ua909\ua926-\ua92d\ua947-\ua953\ua980-\ua983\ua9b3-\ua9c0\ua9d0-\ua9d9\ua9e5\ua9f0-\ua9f9\uaa29-\uaa36\uaa43\uaa4c\uaa4d\uaa50-\uaa59\uaa7b-\uaa7d\uaab0\uaab2-\uaab4\uaab7\uaab8\uaabe\uaabf\uaac1\uaaeb-\uaaef\uaaf5\uaaf6\uabe3-\uabea\uabec\uabed\uabf0-\uabf9\ufb1e\ufe00-\ufe0f\ufe20-\ufe2f\ufe33\ufe34\ufe4d-\ufe4f\uff10-\uff19\uff3f]");
a=null;var d=[0,11,2,25,2,18,2,1,2,14,3,13,35,122,70,52,268,28,4,48,48,31,17,26,6,37,11,29,3,35,5,7,2,4,43,157,99,39,9,51,157,310,10,21,11,7,153,5,3,0,2,43,2,1,4,0,3,22,11,22,10,30,66,18,2,1,11,21,11,25,71,55,7,1,65,0,16,3,2,2,2,26,45,28,4,28,36,7,2,27,28,53,11,21,11,18,14,17,111,72,56,50,14,50,785,52,76,44,33,24,27,35,42,34,4,0,13,47,15,3,22,0,2,0,36,17,2,24,85,6,2,0,2,3,2,14,2,9,8,46,39,7,3,1,3,21,2,6,2,1,2,4,4,0,19,0,13,4,287,47,21,1,2,0,185,46,42,3,37,47,21,0,60,42,86,25,391,63,32,0,449,56,1288,
921,103,110,18,195,2749,1070,4050,582,8634,568,8,30,114,29,19,47,17,3,32,20,6,18,881,68,12,0,67,12,16481,1,3071,106,6,12,4,8,8,9,5991,84,2,70,2,1,3,0,3,1,3,3,2,11,2,0,2,6,2,64,2,3,3,7,2,6,2,27,2,3,2,4,2,0,4,6,2,339,3,24,2,24,2,30,2,24,2,30,2,24,2,30,2,24,2,30,2,24,2,7,4149,196,1340,3,2,26,2,1,2,0,3,0,2,9,2,3,2,0,2,0,7,0,5,0,2,0,2,0,2,2,2,1,2,0,3,0,2,0,2,0,2,0,2,0,2,1,2,0,3,3,2,6,2,3,2,3,2,0,2,9,2,16,6,2,2,4,2,16,4421,42710,42,4148,12,221,3,5761,10591,541],h=[509,0,227,0,150,4,294,9,1368,2,2,1,6,3,
41,2,5,0,166,1,1306,2,54,14,32,9,16,3,46,10,54,9,7,2,37,13,2,9,52,0,13,2,49,13,10,2,4,9,83,11,168,11,6,9,7,3,57,0,2,6,3,1,3,2,10,0,11,1,3,6,4,4,316,19,13,9,214,6,3,8,28,1,83,16,16,9,82,12,9,9,84,14,5,9,423,9,20855,9,135,4,60,6,26,9,1016,45,17,3,19723,1,5319,4,4,5,9,7,3,6,31,3,149,2,1418,49,513,54,5,49,9,0,15,0,23,4,2,14,3617,6,792618,239]},{}],3:[function(a,l,f){f.__esModule=!0;f.parse=function(a,b){return(new c.Parser(b,a)).parse()};f.parseExpressionAt=function(a,b,d){a=new c.Parser(d,a,b);a.nextToken();
return a.parseExpression()};f.tokenizer=function(a,b){return new c.Parser(b,a)};var c=a("./state");a("./parseutil");a("./statement");a("./lval");a("./expression");a("./location");f.Parser=c.Parser;f.plugins=c.plugins;l=a("./options");f.defaultOptions=l.defaultOptions;l=a("./locutil");f.Position=l.Position;f.SourceLocation=l.SourceLocation;f.getLineInfo=l.getLineInfo;l=a("./node");f.Node=l.Node;l=a("./tokentype");f.TokenType=l.TokenType;f.tokTypes=l.types;l=a("./tokencontext");f.TokContext=l.TokContext;
f.tokContexts=l.types;l=a("./identifier");f.isIdentifierChar=l.isIdentifierChar;f.isIdentifierStart=l.isIdentifierStart;l=a("./tokenize");f.Token=l.Token;a=a("./whitespace");f.isNewLine=a.isNewLine;f.lineBreak=a.lineBreak;f.lineBreakG=a.lineBreakG;f.version="3.1.0"},{"./expression":1,"./identifier":2,"./location":4,"./locutil":5,"./lval":6,"./node":7,"./options":8,"./parseutil":9,"./state":10,"./statement":11,"./tokencontext":12,"./tokenize":13,"./tokentype":14,"./whitespace":16}],4:[function(a,l,
f){l=a("./state");var c=a("./locutil");a=l.Parser.prototype;a.raise=function(a,b){var d=c.getLineInfo(this.input,a);b+=" ("+d.line+":"+d.column+")";var h=new SyntaxError(b);h.pos=a;h.loc=d;h.raisedAt=this.pos;throw h;};a.raiseRecoverable=a.raise;a.curPosition=function(){if(this.options.locations)return new c.Position(this.curLine,this.pos-this.lineStart)}},{"./locutil":5,"./state":10}],5:[function(a,l,f){function c(a,b){if(!(a instanceof b))throw new TypeError("Cannot call a class as a function");
}f.__esModule=!0;f.getLineInfo=function(a,c){for(var d=1,e=0;;){g.lineBreakG.lastIndex=e;var m=g.lineBreakG.exec(a);if(m&&m.index<c)++d,e=m.index+m[0].length;else return new b(d,c-e)}};var g=a("./whitespace"),b=function(){function a(b,d){c(this,a);this.line=b;this.column=d}a.prototype.offset=function(b){return new a(this.line,this.column+b)};return a}();f.Position=b;f.SourceLocation=function h(a,b,m){c(this,h);this.start=b;this.end=m;null!==a.sourceFile&&(this.source=a.sourceFile)}},{"./whitespace":16}],
6:[function(a,l,f){var c=a("./tokentype");l=a("./state");var g=a("./util");a=l.Parser.prototype;a.toAssignable=function(a,c){if(6<=this.options.ecmaVersion&&a)switch(a.type){case "Identifier":case "ObjectPattern":case "ArrayPattern":break;case "ObjectExpression":a.type="ObjectPattern";for(var b=0;b<a.properties.length;b++){var d=a.properties[b];"init"!==d.kind&&this.raise(d.key.start,"Object pattern can't contain getter or setter");this.toAssignable(d.value,c)}break;case "ArrayExpression":a.type=
"ArrayPattern";this.toAssignableList(a.elements,c);break;case "AssignmentExpression":if("="===a.operator)a.type="AssignmentPattern",delete a.operator;else{this.raise(a.left.end,"Only '=' operator can be used for specifying default value.");break}case "AssignmentPattern":"YieldExpression"===a.right.type&&this.raise(a.right.start,"Yield expression cannot be a default value");break;case "ParenthesizedExpression":a.expression=this.toAssignable(a.expression,c);break;case "MemberExpression":if(!c)break;
default:this.raise(a.start,"Assigning to rvalue")}return a};a.toAssignableList=function(a,c){var b=a.length;if(b){var d=a[b-1];if(d&&"RestElement"==d.type)--b;else if(d&&"SpreadElement"==d.type){d.type="RestElement";var e=d.argument;this.toAssignable(e,c);"Identifier"!==e.type&&"MemberExpression"!==e.type&&"ArrayPattern"!==e.type&&this.unexpected(e.start);--b}c&&"RestElement"===d.type&&"Identifier"!==d.argument.type&&this.unexpected(d.argument.start)}for(d=0;d<b;d++)(e=a[d])&&this.toAssignable(e,
c);return a};a.parseSpread=function(a){var b=this.startNode();this.next();b.argument=this.parseMaybeAssign(a);return this.finishNode(b,"SpreadElement")};a.parseRest=function(a){var b=this.startNode();this.next();b.argument=a?this.type===c.types.name?this.parseIdent():this.unexpected():this.type===c.types.name||this.type===c.types.bracketL?this.parseBindingAtom():this.unexpected();return this.finishNode(b,"RestElement")};a.parseBindingAtom=function(){if(6>this.options.ecmaVersion)return this.parseIdent();
switch(this.type){case c.types.name:return this.parseIdent();case c.types.bracketL:var a=this.startNode();this.next();a.elements=this.parseBindingList(c.types.bracketR,!0,!0);return this.finishNode(a,"ArrayPattern");case c.types.braceL:return this.parseObj(!0);default:this.unexpected()}};a.parseBindingList=function(a,d,h,n){for(var b=[],m=!0;!this.eat(a);)if(m?m=!1:this.expect(c.types.comma),d&&this.type===c.types.comma)b.push(null);else if(h&&this.afterTrailingComma(a))break;else if(this.type===
c.types.ellipsis){d=this.parseRest(n);this.parseBindingListItem(d);b.push(d);this.type===c.types.comma&&this.raise(this.start,"Comma is not permitted after the rest element");this.expect(a);break}else{var p=this.parseMaybeDefault(this.start,this.startLoc);this.parseBindingListItem(p);b.push(p)}return b};a.parseBindingListItem=function(a){return a};a.parseMaybeDefault=function(a,d,h){h=h||this.parseBindingAtom();if(6>this.options.ecmaVersion||!this.eat(c.types.eq))return h;a=this.startNodeAt(a,d);
a.left=h;a.right=this.parseMaybeAssign();return this.finishNode(a,"AssignmentPattern")};a.checkLVal=function(a,c,h){switch(a.type){case "Identifier":this.strict&&this.reservedWordsStrictBind.test(a.name)&&this.raiseRecoverable(a.start,(c?"Binding ":"Assigning to ")+a.name+" in strict mode");h&&(g.has(h,a.name)&&this.raiseRecoverable(a.start,"Argument name clash"),h[a.name]=!0);break;case "MemberExpression":c&&this.raiseRecoverable(a.start,(c?"Binding":"Assigning to")+" member expression");break;case "ObjectPattern":for(var b=
0;b<a.properties.length;b++)this.checkLVal(a.properties[b].value,c,h);break;case "ArrayPattern":for(b=0;b<a.elements.length;b++){var e=a.elements[b];e&&this.checkLVal(e,c,h)}break;case "AssignmentPattern":this.checkLVal(a.left,c,h);break;case "RestElement":this.checkLVal(a.argument,c,h);break;case "ParenthesizedExpression":this.checkLVal(a.expression,c,h);break;default:this.raise(a.start,(c?"Binding":"Assigning to")+" rvalue")}}},{"./state":10,"./tokentype":14,"./util":15}],7:[function(a,l,f){function c(a,
b,c,e){a.type=b;a.end=c;this.options.locations&&(a.loc.end=e);this.options.ranges&&(a.range[1]=c);return a}f.__esModule=!0;l=a("./state");var g=a("./locutil"),b=function h(a,b,c){if(!(this instanceof h))throw new TypeError("Cannot call a class as a function");this.type="";this.start=b;this.end=0;a.options.locations&&(this.loc=new g.SourceLocation(a,c));a.options.directSourceFile&&(this.sourceFile=a.options.directSourceFile);a.options.ranges&&(this.range=[b,0])};f.Node=b;a=l.Parser.prototype;a.startNode=
function(){return new b(this,this.start,this.startLoc)};a.startNodeAt=function(a,c){return new b(this,a,c)};a.finishNode=function(a,b){return c.call(this,a,b,this.lastTokEnd,this.lastTokEndLoc)};a.finishNodeAt=function(a,b,e,m){return c.call(this,a,b,e,m)}},{"./locutil":5,"./state":10}],8:[function(a,l,f){function c(a,c){return function(e,m,d,h,k,q){e={type:e?"Block":"Line",value:m,start:d,end:h};a.locations&&(e.loc=new b.SourceLocation(this,k,q));a.ranges&&(e.range=[d,h]);c.push(e)}}f.__esModule=
!0;f.getOptions=function(a){var b={},e;for(e in d)b[e]=a&&g.has(a,e)?a[e]:d[e];null==b.allowReserved&&(b.allowReserved=5>b.ecmaVersion);g.isArray(b.onToken)&&function(){var a=b.onToken;b.onToken=function(b){return a.push(b)}}();g.isArray(b.onComment)&&(b.onComment=c(b,b.onComment));return b};var g=a("./util"),b=a("./locutil"),d={ecmaVersion:6,sourceType:"script",onInsertedSemicolon:null,onTrailingComma:null,allowReserved:null,allowReturnOutsideFunction:!1,allowImportExportEverywhere:!1,allowHashBang:!1,
locations:!1,onToken:null,onComment:null,ranges:!1,program:null,sourceFile:null,directSourceFile:null,preserveParens:!1,plugins:{}};f.defaultOptions=d},{"./locutil":5,"./util":15}],9:[function(a,l,f){var c=a("./tokentype");l=a("./state");var g=a("./whitespace");a=l.Parser.prototype;a.isUseStrict=function(a){return 5<=this.options.ecmaVersion&&"ExpressionStatement"===a.type&&"Literal"===a.expression.type&&"use strict"===a.expression.raw.slice(1,-1)};a.eat=function(a){return this.type===a?(this.next(),
!0):!1};a.isContextual=function(a){return this.type===c.types.name&&this.value===a};a.eatContextual=function(a){return this.value===a&&this.eat(c.types.name)};a.expectContextual=function(a){this.eatContextual(a)||this.unexpected()};a.canInsertSemicolon=function(){return this.type===c.types.eof||this.type===c.types.braceR||g.lineBreak.test(this.input.slice(this.lastTokEnd,this.start))};a.insertSemicolon=function(){if(this.canInsertSemicolon()){if(this.options.onInsertedSemicolon)this.options.onInsertedSemicolon(this.lastTokEnd,
this.lastTokEndLoc);return!0}};a.semicolon=function(){this.eat(c.types.semi)||this.insertSemicolon()||this.unexpected()};a.afterTrailingComma=function(a){if(this.type==a){if(this.options.onTrailingComma)this.options.onTrailingComma(this.lastTokStart,this.lastTokStartLoc);this.next();return!0}};a.expect=function(a){this.eat(a)||this.unexpected()};a.unexpected=function(a){this.raise(null!=a?a:this.start,"Unexpected token")};a.checkPatternErrors=function(a,c){var b=a&&a.trailingComma;if(!c)return!!b;
b&&this.raise(b,"Comma is not permitted after the rest element")};a.checkExpressionErrors=function(a,c){var b=a&&a.shorthandAssign;if(!c)return!!b;b&&this.raise(b,"Shorthand property assignments are valid only in destructuring patterns")}},{"./state":10,"./tokentype":14,"./whitespace":16}],10:[function(a,l,f){function c(a){return new RegExp("^("+a.replace(/ /g,"|")+")$")}f.__esModule=!0;var g=a("./identifier"),b=a("./tokentype"),d=a("./whitespace"),h=a("./options"),n={};f.plugins=n;a=function(){function a(e,
p,f){if(!(this instanceof a))throw new TypeError("Cannot call a class as a function");this.options=e=h.getOptions(e);this.sourceFile=e.sourceFile;this.keywords=c(g.keywords[6<=e.ecmaVersion?6:5]);var k=e.allowReserved?"":g.reservedWords[e.ecmaVersion]+("module"==e.sourceType?" await":"");this.reservedWords=c(k);k=(k?k+" ":"")+g.reservedWords.strict;this.reservedWordsStrict=c(k);this.reservedWordsStrictBind=c(k+" "+g.reservedWords.strictBind);this.input=String(p);this.containsEsc=!1;this.loadPlugins(e.plugins);
f?(this.pos=f,this.lineStart=Math.max(0,this.input.lastIndexOf("\n",f)),this.curLine=this.input.slice(0,this.lineStart).split(d.lineBreak).length):(this.pos=this.lineStart=0,this.curLine=1);this.type=b.types.eof;this.value=null;this.start=this.end=this.pos;this.startLoc=this.endLoc=this.curPosition();this.lastTokEndLoc=this.lastTokStartLoc=null;this.lastTokStart=this.lastTokEnd=this.pos;this.context=this.initialContext();this.exprAllowed=!0;this.strict=this.inModule="module"===e.sourceType;this.potentialArrowAt=
-1;this.inFunction=this.inGenerator=!1;this.labels=[];0===this.pos&&e.allowHashBang&&"#!"===this.input.slice(0,2)&&this.skipLineComment(2)}a.prototype.isKeyword=function(a){return this.keywords.test(a)};a.prototype.isReservedWord=function(a){return this.reservedWords.test(a)};a.prototype.extend=function(a,b){this[a]=b(this[a])};a.prototype.loadPlugins=function(a){for(var b in a){var c=n[b];if(!c)throw Error("Plugin '"+b+"' not found");c(this,a[b])}};a.prototype.parse=function(){var a=this.options.program||
this.startNode();this.nextToken();return this.parseTopLevel(a)};return a}();f.Parser=a},{"./identifier":2,"./options":8,"./tokentype":14,"./whitespace":16}],11:[function(a,l,f){var c=a("./tokentype");l=a("./state");var g=a("./whitespace"),b=a("./identifier");a=l.Parser.prototype;a.parseTopLevel=function(a){var b=!0;a.body||(a.body=[]);for(;this.type!==c.types.eof;){var e=this.parseStatement(!0,!0);a.body.push(e);b&&(this.isUseStrict(e)&&this.setStrict(!0),b=!1)}this.next();6<=this.options.ecmaVersion&&
(a.sourceType=this.options.sourceType);return this.finishNode(a,"Program")};var d={kind:"loop"},h={kind:"switch"};a.isLet=function(){if(this.type!==c.types.name||6>this.options.ecmaVersion||"let"!=this.value)return!1;g.skipWhiteSpace.lastIndex=this.pos;var a=g.skipWhiteSpace.exec(this.input),a=this.pos+a[0].length,d=this.input.charCodeAt(a);if(91===d||123==d)return!0;if(b.isIdentifierStart(d,!0)){for(d=a+1;b.isIdentifierChar(this.input.charCodeAt(d,!0));++d);a=this.input.slice(a,d);if(!this.isKeyword(a))return!0}return!1};
a.parseStatement=function(a,b){var e=this.type,d=this.startNode(),k=void 0;this.isLet()&&(e=c.types._var,k="let");switch(e){case c.types._break:case c.types._continue:return this.parseBreakContinueStatement(d,e.keyword);case c.types._debugger:return this.parseDebuggerStatement(d);case c.types._do:return this.parseDoStatement(d);case c.types._for:return this.parseForStatement(d);case c.types._function:return!a&&6<=this.options.ecmaVersion&&this.unexpected(),this.parseFunctionStatement(d);case c.types._class:return a||
this.unexpected(),this.parseClass(d,!0);case c.types._if:return this.parseIfStatement(d);case c.types._return:return this.parseReturnStatement(d);case c.types._switch:return this.parseSwitchStatement(d);case c.types._throw:return this.parseThrowStatement(d);case c.types._try:return this.parseTryStatement(d);case c.types._const:case c.types._var:return k=k||this.value,a||"var"==k||this.unexpected(),this.parseVarStatement(d,k);case c.types._while:return this.parseWhileStatement(d);case c.types._with:return this.parseWithStatement(d);
case c.types.braceL:return this.parseBlock();case c.types.semi:return this.parseEmptyStatement(d);case c.types._export:case c.types._import:return this.options.allowImportExportEverywhere||(b||this.raise(this.start,"'import' and 'export' may only appear at the top level"),this.inModule||this.raise(this.start,"'import' and 'export' may appear only with 'sourceType: module'")),e===c.types._import?this.parseImport(d):this.parseExport(d);default:var k=this.value,m=this.parseExpression();return e===c.types.name&&
"Identifier"===m.type&&this.eat(c.types.colon)?this.parseLabeledStatement(d,k,m):this.parseExpressionStatement(d,m)}};a.parseBreakContinueStatement=function(a,b){var e="break"==b;this.next();this.eat(c.types.semi)||this.insertSemicolon()?a.label=null:this.type!==c.types.name?this.unexpected():(a.label=this.parseIdent(),this.semicolon());for(var d=0;d<this.labels.length;++d){var k=this.labels[d];if(null==a.label||k.name===a.label.name){if(null!=k.kind&&(e||"loop"===k.kind))break;if(a.label&&e)break}}d===
this.labels.length&&this.raise(a.start,"Unsyntactic "+b);return this.finishNode(a,e?"BreakStatement":"ContinueStatement")};a.parseDebuggerStatement=function(a){this.next();this.semicolon();return this.finishNode(a,"DebuggerStatement")};a.parseDoStatement=function(a){this.next();this.labels.push(d);a.body=this.parseStatement(!1);this.labels.pop();this.expect(c.types._while);a.test=this.parseParenExpression();6<=this.options.ecmaVersion?this.eat(c.types.semi):this.semicolon();return this.finishNode(a,
"DoWhileStatement")};a.parseForStatement=function(a){this.next();this.labels.push(d);this.expect(c.types.parenL);if(this.type===c.types.semi)return this.parseFor(a,null);var b=this.isLet();if(this.type===c.types._var||this.type===c.types._const||b){var e=this.startNode(),b=b?"let":this.value;this.next();this.parseVar(e,!0,b);this.finishNode(e,"VariableDeclaration");return!(this.type===c.types._in||6<=this.options.ecmaVersion&&this.isContextual("of"))||1!==e.declarations.length||"var"!==b&&e.declarations[0].init?
this.parseFor(a,e):this.parseForIn(a,e)}e={shorthandAssign:0,trailingComma:0};b=this.parseExpression(!0,e);if(this.type===c.types._in||6<=this.options.ecmaVersion&&this.isContextual("of"))return this.checkPatternErrors(e,!0),this.toAssignable(b),this.checkLVal(b),this.parseForIn(a,b);this.checkExpressionErrors(e,!0);return this.parseFor(a,b)};a.parseFunctionStatement=function(a){this.next();return this.parseFunction(a,!0)};a.parseIfStatement=function(a){this.next();a.test=this.parseParenExpression();
a.consequent=this.parseStatement(!1);a.alternate=this.eat(c.types._else)?this.parseStatement(!1):null;return this.finishNode(a,"IfStatement")};a.parseReturnStatement=function(a){this.inFunction||this.options.allowReturnOutsideFunction||this.raise(this.start,"'return' outside of function");this.next();this.eat(c.types.semi)||this.insertSemicolon()?a.argument=null:(a.argument=this.parseExpression(),this.semicolon());return this.finishNode(a,"ReturnStatement")};a.parseSwitchStatement=function(a){this.next();
a.discriminant=this.parseParenExpression();a.cases=[];this.expect(c.types.braceL);this.labels.push(h);for(var b,e=!1;this.type!=c.types.braceR;)if(this.type===c.types._case||this.type===c.types._default){var d=this.type===c.types._case;b&&this.finishNode(b,"SwitchCase");a.cases.push(b=this.startNode());b.consequent=[];this.next();d?b.test=this.parseExpression():(e&&this.raiseRecoverable(this.lastTokStart,"Multiple default clauses"),e=!0,b.test=null);this.expect(c.types.colon)}else b||this.unexpected(),
b.consequent.push(this.parseStatement(!0));b&&this.finishNode(b,"SwitchCase");this.next();this.labels.pop();return this.finishNode(a,"SwitchStatement")};a.parseThrowStatement=function(a){this.next();g.lineBreak.test(this.input.slice(this.lastTokEnd,this.start))&&this.raise(this.lastTokEnd,"Illegal newline after throw");a.argument=this.parseExpression();this.semicolon();return this.finishNode(a,"ThrowStatement")};var n=[];a.parseTryStatement=function(a){this.next();a.block=this.parseBlock();a.handler=
null;if(this.type===c.types._catch){var b=this.startNode();this.next();this.expect(c.types.parenL);b.param=this.parseBindingAtom();this.checkLVal(b.param,!0);this.expect(c.types.parenR);b.body=this.parseBlock();a.handler=this.finishNode(b,"CatchClause")}a.finalizer=this.eat(c.types._finally)?this.parseBlock():null;a.handler||a.finalizer||this.raise(a.start,"Missing catch or finally clause");return this.finishNode(a,"TryStatement")};a.parseVarStatement=function(a,b){this.next();this.parseVar(a,!1,
b);this.semicolon();return this.finishNode(a,"VariableDeclaration")};a.parseWhileStatement=function(a){this.next();a.test=this.parseParenExpression();this.labels.push(d);a.body=this.parseStatement(!1);this.labels.pop();return this.finishNode(a,"WhileStatement")};a.parseWithStatement=function(a){this.strict&&this.raise(this.start,"'with' in strict mode");this.next();a.object=this.parseParenExpression();a.body=this.parseStatement(!1);return this.finishNode(a,"WithStatement")};a.parseEmptyStatement=
function(a){this.next();return this.finishNode(a,"EmptyStatement")};a.parseLabeledStatement=function(a,b,d){for(var e=0;e<this.labels.length;++e)this.labels[e].name===b&&this.raise(d.start,"Label '"+b+"' is already declared");for(var k=this.type.isLoop?"loop":this.type===c.types._switch?"switch":null,e=this.labels.length-1;0<=e;e--){var q=this.labels[e];if(q.statementStart==a.start)q.statementStart=this.start,q.kind=k;else break}this.labels.push({name:b,kind:k,statementStart:this.start});a.body=this.parseStatement(!0);
this.labels.pop();a.label=d;return this.finishNode(a,"LabeledStatement")};a.parseExpressionStatement=function(a,b){a.expression=b;this.semicolon();return this.finishNode(a,"ExpressionStatement")};a.parseBlock=function(a){var b=this.startNode(),e=!0,d=void 0;b.body=[];for(this.expect(c.types.braceL);!this.eat(c.types.braceR);){var k=this.parseStatement(!0);b.body.push(k);e&&a&&this.isUseStrict(k)&&(d=this.strict,this.setStrict(this.strict=!0));e=!1}!1===d&&this.setStrict(!1);return this.finishNode(b,
"BlockStatement")};a.parseFor=function(a,b){a.init=b;this.expect(c.types.semi);a.test=this.type===c.types.semi?null:this.parseExpression();this.expect(c.types.semi);a.update=this.type===c.types.parenR?null:this.parseExpression();this.expect(c.types.parenR);a.body=this.parseStatement(!1);this.labels.pop();return this.finishNode(a,"ForStatement")};a.parseForIn=function(a,b){var e=this.type===c.types._in?"ForInStatement":"ForOfStatement";this.next();a.left=b;a.right=this.parseExpression();this.expect(c.types.parenR);
a.body=this.parseStatement(!1);this.labels.pop();return this.finishNode(a,e)};a.parseVar=function(a,b,d){a.declarations=[];for(a.kind=d;;){var e=this.startNode();this.parseVarId(e);this.eat(c.types.eq)?e.init=this.parseMaybeAssign(b):"const"!==d||this.type===c.types._in||6<=this.options.ecmaVersion&&this.isContextual("of")?"Identifier"==e.id.type||b&&(this.type===c.types._in||this.isContextual("of"))?e.init=null:this.raise(this.lastTokEnd,"Complex binding patterns require an initialization value"):
this.unexpected();a.declarations.push(this.finishNode(e,"VariableDeclarator"));if(!this.eat(c.types.comma))break}return a};a.parseVarId=function(a){a.id=this.parseBindingAtom();this.checkLVal(a.id,!0)};a.parseFunction=function(a,b,d){this.initFunction(a);6<=this.options.ecmaVersion&&(a.generator=this.eat(c.types.star));var e=this.inGenerator;this.inGenerator=a.generator;if(b||this.type===c.types.name)a.id=this.parseIdent();this.parseFunctionParams(a);this.parseFunctionBody(a,d);this.inGenerator=e;
return this.finishNode(a,b?"FunctionDeclaration":"FunctionExpression")};a.parseFunctionParams=function(a){this.expect(c.types.parenL);a.params=this.parseBindingList(c.types.parenR,!1,!1,!0)};a.parseClass=function(a,b){this.next();this.parseClassId(a,b);this.parseClassSuper(a);var e=this.startNode(),d=!1;e.body=[];for(this.expect(c.types.braceL);!this.eat(c.types.braceR);)if(!this.eat(c.types.semi)){var k=this.startNode(),q=this.eat(c.types.star),h=this.type===c.types.name&&"static"===this.value;this.parsePropertyName(k);
k["static"]=h&&this.type!==c.types.parenL;k["static"]&&(q&&this.unexpected(),q=this.eat(c.types.star),this.parsePropertyName(k));k.kind="method";h=!1;if(!k.computed){var f=k.key;q||"Identifier"!==f.type||this.type===c.types.parenL||"get"!==f.name&&"set"!==f.name||(h=!0,k.kind=f.name,f=this.parsePropertyName(k));!k["static"]&&("Identifier"===f.type&&"constructor"===f.name||"Literal"===f.type&&"constructor"===f.value)&&(d&&this.raise(f.start,"Duplicate constructor in the same class"),h&&this.raise(f.start,
"Constructor can't have get/set modifier"),q&&this.raise(f.start,"Constructor can't be a generator"),k.kind="constructor",d=!0)}this.parseClassMethod(e,k,q);h&&(k.value.params.length!==("get"===k.kind?0:1)&&(q=k.value.start,"get"===k.kind?this.raiseRecoverable(q,"getter should have no params"):this.raiseRecoverable(q,"setter should have exactly one param")),"set"===k.kind&&"RestElement"===k.value.params[0].type&&this.raise(k.value.params[0].start,"Setter cannot use rest params"))}a.body=this.finishNode(e,
"ClassBody");return this.finishNode(a,b?"ClassDeclaration":"ClassExpression")};a.parseClassMethod=function(a,b,c){b.value=this.parseMethod(c);a.body.push(this.finishNode(b,"MethodDefinition"))};a.parseClassId=function(a,b){a.id=this.type===c.types.name?this.parseIdent():b?this.unexpected():null};a.parseClassSuper=function(a){a.superClass=this.eat(c.types._extends)?this.parseExprSubscripts():null};a.parseExport=function(a){this.next();if(this.eat(c.types.star))return this.expectContextual("from"),
a.source=this.type===c.types.string?this.parseExprAtom():this.unexpected(),this.semicolon(),this.finishNode(a,"ExportAllDeclaration");if(this.eat(c.types._default)){var b=this.type==c.types.parenL,e=this.parseMaybeAssign(),d=!0;b||"FunctionExpression"!=e.type&&"ClassExpression"!=e.type||(d=!1,e.id&&(e.type="FunctionExpression"==e.type?"FunctionDeclaration":"ClassDeclaration"));a.declaration=e;d&&this.semicolon();return this.finishNode(a,"ExportDefaultDeclaration")}if(this.shouldParseExportStatement())a.declaration=
this.parseStatement(!0),a.specifiers=[],a.source=null;else{a.declaration=null;a.specifiers=this.parseExportSpecifiers();if(this.eatContextual("from"))a.source=this.type===c.types.string?this.parseExprAtom():this.unexpected();else{for(b=0;b<a.specifiers.length;b++)(this.keywords.test(a.specifiers[b].local.name)||this.reservedWords.test(a.specifiers[b].local.name))&&this.unexpected(a.specifiers[b].local.start);a.source=null}this.semicolon()}return this.finishNode(a,"ExportNamedDeclaration")};a.shouldParseExportStatement=
function(){return this.type.keyword||this.isLet()};a.parseExportSpecifiers=function(){var a=[],b=!0;for(this.expect(c.types.braceL);!this.eat(c.types.braceR);){if(b)b=!1;else if(this.expect(c.types.comma),this.afterTrailingComma(c.types.braceR))break;var d=this.startNode();d.local=this.parseIdent(this.type===c.types._default);d.exported=this.eatContextual("as")?this.parseIdent(!0):d.local;a.push(this.finishNode(d,"ExportSpecifier"))}return a};a.parseImport=function(a){this.next();this.type===c.types.string?
(a.specifiers=n,a.source=this.parseExprAtom()):(a.specifiers=this.parseImportSpecifiers(),this.expectContextual("from"),a.source=this.type===c.types.string?this.parseExprAtom():this.unexpected());this.semicolon();return this.finishNode(a,"ImportDeclaration")};a.parseImportSpecifiers=function(){var a=[],b=!0;if(this.type===c.types.name){var d=this.startNode();d.local=this.parseIdent();this.checkLVal(d.local,!0);a.push(this.finishNode(d,"ImportDefaultSpecifier"));if(!this.eat(c.types.comma))return a}if(this.type===
c.types.star)return d=this.startNode(),this.next(),this.expectContextual("as"),d.local=this.parseIdent(),this.checkLVal(d.local,!0),a.push(this.finishNode(d,"ImportNamespaceSpecifier")),a;for(this.expect(c.types.braceL);!this.eat(c.types.braceR);){if(b)b=!1;else if(this.expect(c.types.comma),this.afterTrailingComma(c.types.braceR))break;d=this.startNode();d.imported=this.parseIdent(!0);this.eatContextual("as")?d.local=this.parseIdent():(d.local=d.imported,this.isKeyword(d.local.name)&&this.unexpected(d.local.start),
this.reservedWordsStrict.test(d.local.name)&&this.raise(d.local.start,"The keyword '"+d.local.name+"' is reserved"));this.checkLVal(d.local,!0);a.push(this.finishNode(d,"ImportSpecifier"))}return a}},{"./identifier":2,"./state":10,"./tokentype":14,"./whitespace":16}],12:[function(a,l,f){f.__esModule=!0;l=a("./state");var c=a("./tokentype"),g=a("./whitespace");a=function h(a,b,c,f){if(!(this instanceof h))throw new TypeError("Cannot call a class as a function");this.token=a;this.isExpr=!!b;this.preserveSpace=
!!c;this.override=f};f.TokContext=a;var b={b_stat:new a("{",!1),b_expr:new a("{",!0),b_tmpl:new a("${",!0),p_stat:new a("(",!1),p_expr:new a("(",!0),q_tmpl:new a("`",!0,!0,function(a){return a.readTmplToken()}),f_expr:new a("function",!0)};f.types=b;f=l.Parser.prototype;f.initialContext=function(){return[b.b_stat]};f.braceIsBlock=function(a){if(a===c.types.colon){var f=this.curContext();if(f===b.b_stat||f===b.b_expr)return!f.isExpr}return a===c.types._return?g.lineBreak.test(this.input.slice(this.lastTokEnd,
this.start)):a===c.types._else||a===c.types.semi||a===c.types.eof||a===c.types.parenR?!0:a==c.types.braceL?this.curContext()===b.b_stat:!this.exprAllowed};f.updateContext=function(a){var b,e=this.type;e.keyword&&a==c.types.dot?this.exprAllowed=!1:(b=e.updateContext)?b.call(this,a):this.exprAllowed=e.beforeExpr};c.types.parenR.updateContext=c.types.braceR.updateContext=function(){if(1==this.context.length)this.exprAllowed=!0;else{var a=this.context.pop();a===b.b_stat&&this.curContext()===b.f_expr?
(this.context.pop(),this.exprAllowed=!1):this.exprAllowed=a===b.b_tmpl?!0:!a.isExpr}};c.types.braceL.updateContext=function(a){this.context.push(this.braceIsBlock(a)?b.b_stat:b.b_expr);this.exprAllowed=!0};c.types.dollarBraceL.updateContext=function(){this.context.push(b.b_tmpl);this.exprAllowed=!0};c.types.parenL.updateContext=function(a){this.context.push(a===c.types._if||a===c.types._for||a===c.types._with||a===c.types._while?b.p_stat:b.p_expr);this.exprAllowed=!0};c.types.incDec.updateContext=
function(){};c.types._function.updateContext=function(a){!a.beforeExpr||a===c.types.semi||a===c.types._else||a===c.types.colon&&this.curContext()===b.b_stat||this.context.push(b.f_expr);this.exprAllowed=!1};c.types.backQuote.updateContext=function(){this.curContext()===b.q_tmpl?this.context.pop():this.context.push(b.q_tmpl);this.exprAllowed=!1}},{"./state":10,"./tokentype":14,"./whitespace":16}],13:[function(a,l,f){function c(a,b,c,d){try{return new RegExp(a,b)}catch(t){if(void 0!==c)throw t instanceof
SyntaxError&&d.raise(c,"Error parsing regular expression: "+t.message),t;}}function g(a){if(65535>=a)return String.fromCharCode(a);a-=65536;return String.fromCharCode((a>>10)+55296,(a&1023)+56320)}f.__esModule=!0;var b=a("./identifier"),d=a("./tokentype");l=a("./state");var h=a("./locutil"),n=a("./whitespace"),e=function k(a){if(!(this instanceof k))throw new TypeError("Cannot call a class as a function");this.type=a.type;this.value=a.value;this.start=a.start;this.end=a.end;a.options.locations&&(this.loc=
new h.SourceLocation(a,a.startLoc,a.endLoc));a.options.ranges&&(this.range=[a.start,a.end])};f.Token=e;a=l.Parser.prototype;var m="object"==typeof Packages&&"[object JavaPackage]"==Object.prototype.toString.call(Packages);a.next=function(){if(this.options.onToken)this.options.onToken(new e(this));this.lastTokEnd=this.end;this.lastTokStart=this.start;this.lastTokEndLoc=this.endLoc;this.lastTokStartLoc=this.startLoc;this.nextToken()};a.getToken=function(){this.next();return new e(this)};"undefined"!==
typeof Symbol&&(a[Symbol.iterator]=function(){var a=this;return{next:function(){var b=a.getToken();return{done:b.type===d.types.eof,value:b}}}});a.setStrict=function(a){this.strict=a;if(this.type===d.types.num||this.type===d.types.string){this.pos=this.start;if(this.options.locations)for(;this.pos<this.lineStart;)this.lineStart=this.input.lastIndexOf("\n",this.lineStart-2)+1,--this.curLine;this.nextToken()}};a.curContext=function(){return this.context[this.context.length-1]};a.nextToken=function(){var a=
this.curContext();a&&a.preserveSpace||this.skipSpace();this.start=this.pos;this.options.locations&&(this.startLoc=this.curPosition());if(this.pos>=this.input.length)return this.finishToken(d.types.eof);if(a.override)return a.override(this);this.readToken(this.fullCharCodeAtPos())};a.readToken=function(a){return b.isIdentifierStart(a,6<=this.options.ecmaVersion)||92===a?this.readWord():this.getTokenFromCode(a)};a.fullCharCodeAtPos=function(){var a=this.input.charCodeAt(this.pos);if(55295>=a||57344<=
a)return a;var b=this.input.charCodeAt(this.pos+1);return(a<<10)+b-56613888};a.skipBlockComment=function(){var a=this.options.onComment&&this.curPosition(),b=this.pos,c=this.input.indexOf("*/",this.pos+=2);-1===c&&this.raise(this.pos-2,"Unterminated comment");this.pos=c+2;if(this.options.locations){n.lineBreakG.lastIndex=b;for(var d=void 0;(d=n.lineBreakG.exec(this.input))&&d.index<this.pos;)++this.curLine,this.lineStart=d.index+d[0].length}if(this.options.onComment)this.options.onComment(!0,this.input.slice(b+
2,c),b,this.pos,a,this.curPosition())};a.skipLineComment=function(a){for(var b=this.pos,c=this.options.onComment&&this.curPosition(),d=this.input.charCodeAt(this.pos+=a);this.pos<this.input.length&&10!==d&&13!==d&&8232!==d&&8233!==d;)++this.pos,d=this.input.charCodeAt(this.pos);if(this.options.onComment)this.options.onComment(!1,this.input.slice(b+a,this.pos),b,this.pos,c,this.curPosition())};a.skipSpace=function(){a:for(;this.pos<this.input.length;){var a=this.input.charCodeAt(this.pos);switch(a){case 32:case 160:++this.pos;
break;case 13:10===this.input.charCodeAt(this.pos+1)&&++this.pos;case 10:case 8232:case 8233:++this.pos;this.options.locations&&(++this.curLine,this.lineStart=this.pos);break;case 47:switch(this.input.charCodeAt(this.pos+1)){case 42:this.skipBlockComment();break;case 47:this.skipLineComment(2);break;default:break a}break;default:if(8<a&&14>a||5760<=a&&n.nonASCIIwhitespace.test(String.fromCharCode(a)))++this.pos;else break a}}};a.finishToken=function(a,b){this.end=this.pos;this.options.locations&&
(this.endLoc=this.curPosition());var c=this.type;this.type=a;this.value=b;this.updateContext(c)};a.readToken_dot=function(){var a=this.input.charCodeAt(this.pos+1);if(48<=a&&57>=a)return this.readNumber(!0);var b=this.input.charCodeAt(this.pos+2);if(6<=this.options.ecmaVersion&&46===a&&46===b)return this.pos+=3,this.finishToken(d.types.ellipsis);++this.pos;return this.finishToken(d.types.dot)};a.readToken_slash=function(){var a=this.input.charCodeAt(this.pos+1);return this.exprAllowed?(++this.pos,
this.readRegexp()):61===a?this.finishOp(d.types.assign,2):this.finishOp(d.types.slash,1)};a.readToken_mult_modulo_exp=function(a){var b=this.input.charCodeAt(this.pos+1),c=1;a=42===a?d.types.star:d.types.modulo;7<=this.options.ecmaVersion&&42===b&&(++c,a=d.types.starstar,b=this.input.charCodeAt(this.pos+2));return 61===b?this.finishOp(d.types.assign,c+1):this.finishOp(a,c)};a.readToken_pipe_amp=function(a){var b=this.input.charCodeAt(this.pos+1);return b===a?this.finishOp(124===a?d.types.logicalOR:
d.types.logicalAND,2):61===b?this.finishOp(d.types.assign,2):this.finishOp(124===a?d.types.bitwiseOR:d.types.bitwiseAND,1)};a.readToken_caret=function(){return 61===this.input.charCodeAt(this.pos+1)?this.finishOp(d.types.assign,2):this.finishOp(d.types.bitwiseXOR,1)};a.readToken_plus_min=function(a){var b=this.input.charCodeAt(this.pos+1);return b===a?45==b&&62==this.input.charCodeAt(this.pos+2)&&n.lineBreak.test(this.input.slice(this.lastTokEnd,this.pos))?(this.skipLineComment(3),this.skipSpace(),
this.nextToken()):this.finishOp(d.types.incDec,2):61===b?this.finishOp(d.types.assign,2):this.finishOp(d.types.plusMin,1)};a.readToken_lt_gt=function(a){var b=this.input.charCodeAt(this.pos+1),c=1;if(b===a)return c=62===a&&62===this.input.charCodeAt(this.pos+2)?3:2,61===this.input.charCodeAt(this.pos+c)?this.finishOp(d.types.assign,c+1):this.finishOp(d.types.bitShift,c);if(33==b&&60==a&&45==this.input.charCodeAt(this.pos+2)&&45==this.input.charCodeAt(this.pos+3))return this.inModule&&this.unexpected(),
this.skipLineComment(4),this.skipSpace(),this.nextToken();61===b&&(c=2);return this.finishOp(d.types.relational,c)};a.readToken_eq_excl=function(a){var b=this.input.charCodeAt(this.pos+1);return 61===b?this.finishOp(d.types.equality,61===this.input.charCodeAt(this.pos+2)?3:2):61===a&&62===b&&6<=this.options.ecmaVersion?(this.pos+=2,this.finishToken(d.types.arrow)):this.finishOp(61===a?d.types.eq:d.types.prefix,1)};a.getTokenFromCode=function(a){switch(a){case 46:return this.readToken_dot();case 40:return++this.pos,
this.finishToken(d.types.parenL);case 41:return++this.pos,this.finishToken(d.types.parenR);case 59:return++this.pos,this.finishToken(d.types.semi);case 44:return++this.pos,this.finishToken(d.types.comma);case 91:return++this.pos,this.finishToken(d.types.bracketL);case 93:return++this.pos,this.finishToken(d.types.bracketR);case 123:return++this.pos,this.finishToken(d.types.braceL);case 125:return++this.pos,this.finishToken(d.types.braceR);case 58:return++this.pos,this.finishToken(d.types.colon);case 63:return++this.pos,
this.finishToken(d.types.question);case 96:if(6>this.options.ecmaVersion)break;++this.pos;return this.finishToken(d.types.backQuote);case 48:a=this.input.charCodeAt(this.pos+1);if(120===a||88===a)return this.readRadixNumber(16);if(6<=this.options.ecmaVersion){if(111===a||79===a)return this.readRadixNumber(8);if(98===a||66===a)return this.readRadixNumber(2)}case 49:case 50:case 51:case 52:case 53:case 54:case 55:case 56:case 57:return this.readNumber(!1);case 34:case 39:return this.readString(a);case 47:return this.readToken_slash();
case 37:case 42:return this.readToken_mult_modulo_exp(a);case 124:case 38:return this.readToken_pipe_amp(a);case 94:return this.readToken_caret();case 43:case 45:return this.readToken_plus_min(a);case 60:case 62:return this.readToken_lt_gt(a);case 61:case 33:return this.readToken_eq_excl(a);case 126:return this.finishOp(d.types.prefix,1)}this.raise(this.pos,"Unexpected character '"+g(a)+"'")};a.finishOp=function(a,b){var c=this.input.slice(this.pos,this.pos+b);this.pos+=b;return this.finishToken(a,
c)};var p=!!c("\uffff","u");a.readRegexp=function(){for(var a=this,b=void 0,e=void 0,f=this.pos;;){this.pos>=this.input.length&&this.raise(f,"Unterminated regular expression");var g=this.input.charAt(this.pos);n.lineBreak.test(g)&&this.raise(f,"Unterminated regular expression");if(b)b=!1;else{if("["===g)e=!0;else if("]"===g&&e)e=!1;else if("/"===g&&!e)break;b="\\"===g}++this.pos}b=this.input.slice(f,this.pos);++this.pos;e=this.readWord1();g=b;if(e){var h=/^[gim]*$/;6<=this.options.ecmaVersion&&(h=
/^[gimuy]*$/);h.test(e)||this.raise(f,"Invalid regular expression flag");0<=e.indexOf("u")&&!p&&(g=g.replace(/\\u\{([0-9a-fA-F]+)\}/g,function(b,c,d){c=Number("0x"+c);1114111<c&&a.raise(f+d+3,"Code point out of bounds");return"x"}),g=g.replace(/\\u([a-fA-F0-9]{4})|[\uD800-\uDBFF][\uDC00-\uDFFF]/g,"x"))}h=null;m||(c(g,void 0,f,this),h=c(b,e));return this.finishToken(d.types.regexp,{pattern:b,flags:e,value:h})};a.readInt=function(a,b){for(var c=this.pos,d=0,e=0,f=null==b?Infinity:b;e<f;++e){var k=this.input.charCodeAt(this.pos),
k=97<=k?k-97+10:65<=k?k-65+10:48<=k&&57>=k?k-48:Infinity;if(k>=a)break;++this.pos;d=d*a+k}return this.pos===c||null!=b&&this.pos-c!==b?null:d};a.readRadixNumber=function(a){this.pos+=2;var c=this.readInt(a);null==c&&this.raise(this.start+2,"Expected number in radix "+a);b.isIdentifierStart(this.fullCharCodeAtPos())&&this.raise(this.pos,"Identifier directly after number");return this.finishToken(d.types.num,c)};a.readNumber=function(a){var c=this.pos,e=!1,f=48===this.input.charCodeAt(this.pos);a||
null!==this.readInt(10)||this.raise(c,"Invalid number");a=this.input.charCodeAt(this.pos);46===a&&(++this.pos,this.readInt(10),e=!0,a=this.input.charCodeAt(this.pos));if(69===a||101===a)a=this.input.charCodeAt(++this.pos),43!==a&&45!==a||++this.pos,null===this.readInt(10)&&this.raise(c,"Invalid number"),e=!0;b.isIdentifierStart(this.fullCharCodeAtPos())&&this.raise(this.pos,"Identifier directly after number");a=this.input.slice(c,this.pos);var k=void 0;e?k=parseFloat(a):f&&1!==a.length?/[89]/.test(a)||
this.strict?this.raise(c,"Invalid number"):k=parseInt(a,8):k=parseInt(a,10);return this.finishToken(d.types.num,k)};a.readCodePoint=function(){if(123===this.input.charCodeAt(this.pos)){6>this.options.ecmaVersion&&this.unexpected();var a=++this.pos;var b=this.readHexChar(this.input.indexOf("}",this.pos)-this.pos);++this.pos;1114111<b&&this.raise(a,"Code point out of bounds")}else b=this.readHexChar(4);return b};a.readString=function(a){for(var b="",c=++this.pos;;){this.pos>=this.input.length&&this.raise(this.start,
"Unterminated string constant");var e=this.input.charCodeAt(this.pos);if(e===a)break;92===e?(b+=this.input.slice(c,this.pos),b+=this.readEscapedChar(!1),c=this.pos):(n.isNewLine(e)&&this.raise(this.start,"Unterminated string constant"),++this.pos)}b+=this.input.slice(c,this.pos++);return this.finishToken(d.types.string,b)};a.readTmplToken=function(){for(var a="",b=this.pos;;){this.pos>=this.input.length&&this.raise(this.start,"Unterminated template");var c=this.input.charCodeAt(this.pos);if(96===
c||36===c&&123===this.input.charCodeAt(this.pos+1)){if(this.pos===this.start&&this.type===d.types.template){if(36===c)return this.pos+=2,this.finishToken(d.types.dollarBraceL);++this.pos;return this.finishToken(d.types.backQuote)}a+=this.input.slice(b,this.pos);return this.finishToken(d.types.template,a)}if(92===c)a+=this.input.slice(b,this.pos),a+=this.readEscapedChar(!0),b=this.pos;else if(n.isNewLine(c)){a+=this.input.slice(b,this.pos);++this.pos;switch(c){case 13:10===this.input.charCodeAt(this.pos)&&
++this.pos;case 10:a+="\n";break;default:a+=String.fromCharCode(c)}this.options.locations&&(++this.curLine,this.lineStart=this.pos);b=this.pos}else++this.pos}};a.readEscapedChar=function(a){var b=this.input.charCodeAt(++this.pos);++this.pos;switch(b){case 110:return"\n";case 114:return"\r";case 120:return String.fromCharCode(this.readHexChar(2));case 117:return g(this.readCodePoint());case 116:return"\t";case 98:return"\b";case 118:return"\x0B";case 102:return"\f";case 13:10===this.input.charCodeAt(this.pos)&&
++this.pos;case 10:return this.options.locations&&(this.lineStart=this.pos,++this.curLine),"";default:if(48<=b&&55>=b){var b=this.input.substr(this.pos-1,3).match(/^[0-7]+/)[0],c=parseInt(b,8);255<c&&(b=b.slice(0,-1),c=parseInt(b,8));"0"!==b&&(this.strict||a)&&this.raise(this.pos-2,"Octal literal in strict mode");this.pos+=b.length-1;return String.fromCharCode(c)}return String.fromCharCode(b)}};a.readHexChar=function(a){var b=this.pos;a=this.readInt(16,a);null===a&&this.raise(b,"Bad character escape sequence");
return a};a.readWord1=function(){this.containsEsc=!1;for(var a="",c=!0,d=this.pos,e=6<=this.options.ecmaVersion;this.pos<this.input.length;){var f=this.fullCharCodeAtPos();if(b.isIdentifierChar(f,e))this.pos+=65535>=f?1:2;else if(92===f)this.containsEsc=!0,a+=this.input.slice(d,this.pos),d=this.pos,117!=this.input.charCodeAt(++this.pos)&&this.raise(this.pos,"Expecting Unicode escape sequence \\uXXXX"),++this.pos,f=this.readCodePoint(),(c?b.isIdentifierStart:b.isIdentifierChar)(f,e)||this.raise(d,
"Invalid Unicode escape"),a+=g(f),d=this.pos;else break;c=!1}return a+this.input.slice(d,this.pos)};a.readWord=function(){var a=this.readWord1(),b=d.types.name;(6<=this.options.ecmaVersion||!this.containsEsc)&&this.keywords.test(a)&&(b=d.keywords[a]);return this.finishToken(b,a)}},{"./identifier":2,"./locutil":5,"./state":10,"./tokentype":14,"./whitespace":16}],14:[function(a,l,f){function c(a,c){return new b(a,{beforeExpr:!0,binop:c})}function g(a){var c=1>=arguments.length||void 0===arguments[1]?
{}:arguments[1];c.keyword=a;h[a]=d["_"+a]=new b(a,c)}f.__esModule=!0;var b=function e(a){var b=1>=arguments.length||void 0===arguments[1]?{}:arguments[1];if(!(this instanceof e))throw new TypeError("Cannot call a class as a function");this.label=a;this.keyword=b.keyword;this.beforeExpr=!!b.beforeExpr;this.startsExpr=!!b.startsExpr;this.isLoop=!!b.isLoop;this.isAssign=!!b.isAssign;this.prefix=!!b.prefix;this.postfix=!!b.postfix;this.binop=b.binop||null;this.updateContext=null};f.TokenType=b;a={beforeExpr:!0};
l={startsExpr:!0};var d={num:new b("num",l),regexp:new b("regexp",l),string:new b("string",l),name:new b("name",l),eof:new b("eof"),bracketL:new b("[",{beforeExpr:!0,startsExpr:!0}),bracketR:new b("]"),braceL:new b("{",{beforeExpr:!0,startsExpr:!0}),braceR:new b("}"),parenL:new b("(",{beforeExpr:!0,startsExpr:!0}),parenR:new b(")"),comma:new b(",",a),semi:new b(";",a),colon:new b(":",a),dot:new b("."),question:new b("?",a),arrow:new b("=>",a),template:new b("template"),ellipsis:new b("...",a),backQuote:new b("`",
l),dollarBraceL:new b("${",{beforeExpr:!0,startsExpr:!0}),eq:new b("=",{beforeExpr:!0,isAssign:!0}),assign:new b("_=",{beforeExpr:!0,isAssign:!0}),incDec:new b("++/--",{prefix:!0,postfix:!0,startsExpr:!0}),prefix:new b("prefix",{beforeExpr:!0,prefix:!0,startsExpr:!0}),logicalOR:c("||",1),logicalAND:c("&&",2),bitwiseOR:c("|",3),bitwiseXOR:c("^",4),bitwiseAND:c("&",5),equality:c("==/!=",6),relational:c("</>",7),bitShift:c("<</>>",8),plusMin:new b("+/-",{beforeExpr:!0,binop:9,prefix:!0,startsExpr:!0}),
modulo:c("%",10),star:c("*",10),slash:c("/",10),starstar:new b("**",{beforeExpr:!0})};f.types=d;var h={};f.keywords=h;g("break");g("case",a);g("catch");g("continue");g("debugger");g("default",a);g("do",{isLoop:!0,beforeExpr:!0});g("else",a);g("finally");g("for",{isLoop:!0});g("function",l);g("if");g("return",a);g("switch");g("throw",a);g("try");g("var");g("const");g("while",{isLoop:!0});g("with");g("new",{beforeExpr:!0,startsExpr:!0});g("this",l);g("super",l);g("class");g("extends",a);g("export");
g("import");g("null",l);g("true",l);g("false",l);g("in",{beforeExpr:!0,binop:7});g("instanceof",{beforeExpr:!0,binop:7});g("typeof",{beforeExpr:!0,prefix:!0,startsExpr:!0});g("void",{beforeExpr:!0,prefix:!0,startsExpr:!0});g("delete",{beforeExpr:!0,prefix:!0,startsExpr:!0})},{}],15:[function(a,l,f){f.__esModule=!0;f.isArray=function(a){return"[object Array]"===Object.prototype.toString.call(a)};f.has=function(a,f){return Object.prototype.hasOwnProperty.call(a,f)}},{}],16:[function(a,l,f){f.__esModule=
!0;f.isNewLine=function(a){return 10===a||13===a||8232===a||8233==a};a=/\r\n?|\n|\u2028|\u2029/;f.lineBreak=a;f.lineBreakG=new RegExp(a.source,"g");f.nonASCIIwhitespace=/[\u1680\u180e\u2000-\u200a\u202f\u205f\u3000\ufeff]/;f.skipWhiteSpace=/(?:\s|\/\/.*|\/\*[^]*?\*\/)*/g},{}]},{},[3])(3)});
var UPNG = {};

	

UPNG.toRGBA8 = function(out)
{
	var w = out.width, h = out.height;
	if(out.tabs.acTL==null) return [UPNG.toRGBA8.decodeImage(out.data, w, h, out).buffer];
	
	var frms = [];
	if(out.frames[0].data==null) out.frames[0].data = out.data;
	
	var img, empty = new Uint8Array(w*h*4);
	for(var i=0; i<out.frames.length; i++)
	{
		var frm = out.frames[i];
		var fx=frm.rect.x, fy=frm.rect.y, fw = frm.rect.width, fh = frm.rect.height;
		var fdata = UPNG.toRGBA8.decodeImage(frm.data, fw,fh, out);
		
		if(i==0) img = fdata;
		else if(frm.blend  ==0) UPNG._copyTile(fdata, fw, fh, img, w, h, fx, fy, 0);
		else if(frm.blend  ==1) UPNG._copyTile(fdata, fw, fh, img, w, h, fx, fy, 1);
		
		frms.push(img.buffer);  img = img.slice(0);
		
		if     (frm.dispose==0) {}
		else if(frm.dispose==1) UPNG._copyTile(empty, fw, fh, img, w, h, fx, fy, 0);
		else if(frm.dispose==2) {
			var pi = i-1;
			while(out.frames[pi].dispose==2) pi--;
			img = new Uint8Array(frms[pi]).slice(0);
		}
	}
	return frms;
}
UPNG.toRGBA8.decodeImage = function(data, w, h, out)
{
	var area = w*h, bpp = UPNG.decode._getBPP(out);
	var bpl = Math.ceil(w*bpp/8);	// bytes per line

	var bf = new Uint8Array(area*4), bf32 = new Uint32Array(bf.buffer);
	var ctype = out.ctype, depth = out.depth;
	var rs = UPNG._bin.readUshort;
	
	//console.log(ctype, depth);

	if     (ctype==6) { // RGB + alpha
		var qarea = area<<2;
		if(depth== 8) for(var i=0; i<qarea;i++) {  bf[i] = data[i];  /*if((i&3)==3 && data[i]!=0) bf[i]=255;*/ }
		if(depth==16) for(var i=0; i<qarea;i++) {  bf[i] = data[i<<1];  }
	}
	else if(ctype==2) {	// RGB
		var ts=out.tabs["tRNS"], tr=-1, tg=-1, tb=-1;
		if(ts) {  tr=ts[0];  tg=ts[1];  tb=ts[2];  }
		if(depth== 8) for(var i=0; i<area; i++) {  var qi=i<<2, ti=i*3;  bf[qi] = data[ti];  bf[qi+1] = data[ti+1];  bf[qi+2] = data[ti+2];  bf[qi+3] = 255;
			if(tr!=-1 && data[ti]   ==tr && data[ti+1]   ==tg && data[ti+2]   ==tb) bf[qi+3] = 0;  }
		if(depth==16) for(var i=0; i<area; i++) {  var qi=i<<2, ti=i*6;  bf[qi] = data[ti];  bf[qi+1] = data[ti+2];  bf[qi+2] = data[ti+4];  bf[qi+3] = 255;
			if(tr!=-1 && rs(data,ti)==tr && rs(data,ti+2)==tg && rs(data,ti+4)==tb) bf[qi+3] = 0;  }
	}
	else if(ctype==3) {	// palette
		var p=out.tabs["PLTE"], ap=out.tabs["tRNS"], tl=ap?ap.length:0;
		//console.log(p, ap);
		if(depth==1) for(var y=0; y<h; y++) {  var s0 = y*bpl, t0 = y*w;
			for(var i=0; i<w; i++) { var qi=(t0+i)<<2, j=((data[s0+(i>>3)]>>(7-((i&7)<<0)))& 1), cj=3*j;  bf[qi]=p[cj];  bf[qi+1]=p[cj+1];  bf[qi+2]=p[cj+2];  bf[qi+3]=(j<tl)?ap[j]:255;  }
		}
		if(depth==2) for(var y=0; y<h; y++) {  var s0 = y*bpl, t0 = y*w;
			for(var i=0; i<w; i++) { var qi=(t0+i)<<2, j=((data[s0+(i>>2)]>>(6-((i&3)<<1)))& 3), cj=3*j;  bf[qi]=p[cj];  bf[qi+1]=p[cj+1];  bf[qi+2]=p[cj+2];  bf[qi+3]=(j<tl)?ap[j]:255;  }
		}
		if(depth==4) for(var y=0; y<h; y++) {  var s0 = y*bpl, t0 = y*w;
			for(var i=0; i<w; i++) { var qi=(t0+i)<<2, j=((data[s0+(i>>1)]>>(4-((i&1)<<2)))&15), cj=3*j;  bf[qi]=p[cj];  bf[qi+1]=p[cj+1];  bf[qi+2]=p[cj+2];  bf[qi+3]=(j<tl)?ap[j]:255;  }
		}
		if(depth==8) for(var i=0; i<area; i++ ) {  var qi=i<<2, j=data[i]                      , cj=3*j;  bf[qi]=p[cj];  bf[qi+1]=p[cj+1];  bf[qi+2]=p[cj+2];  bf[qi+3]=(j<tl)?ap[j]:255;  }
	}
	else if(ctype==4) {	// gray + alpha
		if(depth== 8)  for(var i=0; i<area; i++) {  var qi=i<<2, di=i<<1, gr=data[di];  bf[qi]=gr;  bf[qi+1]=gr;  bf[qi+2]=gr;  bf[qi+3]=data[di+1];  }
		if(depth==16)  for(var i=0; i<area; i++) {  var qi=i<<2, di=i<<2, gr=data[di];  bf[qi]=gr;  bf[qi+1]=gr;  bf[qi+2]=gr;  bf[qi+3]=data[di+2];  }
	}
	else if(ctype==0) {	// gray
		var tr = out.tabs["tRNS"] ? out.tabs["tRNS"] : -1;
		if(depth== 1) for(var i=0; i<area; i++) {  var gr=255*((data[i>>3]>>(7 -((i&7)   )))& 1), al=(gr==tr*255)?0:255;  bf32[i]=(al<<24)|(gr<<16)|(gr<<8)|gr;  }
		if(depth== 2) for(var i=0; i<area; i++) {  var gr= 85*((data[i>>2]>>(6 -((i&3)<<1)))& 3), al=(gr==tr* 85)?0:255;  bf32[i]=(al<<24)|(gr<<16)|(gr<<8)|gr;  }
		if(depth== 4) for(var i=0; i<area; i++) {  var gr= 17*((data[i>>1]>>(4 -((i&1)<<2)))&15), al=(gr==tr* 17)?0:255;  bf32[i]=(al<<24)|(gr<<16)|(gr<<8)|gr;  }
		if(depth== 8) for(var i=0; i<area; i++) {  var gr=data[i  ] , al=(gr           ==tr)?0:255;  bf32[i]=(al<<24)|(gr<<16)|(gr<<8)|gr;  }
		if(depth==16) for(var i=0; i<area; i++) {  var gr=data[i<<1], al=(rs(data,i<<1)==tr)?0:255;  bf32[i]=(al<<24)|(gr<<16)|(gr<<8)|gr;  }
	}
	return bf;
}



UPNG.decode = function(buff)
{
	var data = new Uint8Array(buff), offset = 8, bin = UPNG._bin, rUs = bin.readUshort, rUi = bin.readUint;
	var out = {tabs:{}, frames:[]};
	var dd = new Uint8Array(data.length), doff = 0;	 // put all IDAT data into it
	var fd, foff = 0;	// frames
	
	var mgck = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	for(var i=0; i<8; i++) if(data[i]!=mgck[i]) throw "The input is not a PNG file!";

	while(offset<data.length)
	{
		var len  = bin.readUint(data, offset);  offset += 4;
		var type = bin.readASCII(data, offset, 4);  offset += 4;
		//console.log(type,len);
		
		if     (type=="IHDR")  {  UPNG.decode._IHDR(data, offset, out);  }
		else if(type=="IDAT") {
			for(var i=0; i<len; i++) dd[doff+i] = data[offset+i];
			doff += len;
		}
		else if(type=="acTL")  {
			out.tabs[type] = {  num_frames:rUi(data, offset), num_plays:rUi(data, offset+4)  };
			fd = new Uint8Array(data.length);
		}
		else if(type=="fcTL")  {
			if(foff!=0) {  var fr = out.frames[out.frames.length-1];
				fr.data = UPNG.decode._decompress(out, fd.slice(0,foff), fr.rect.width, fr.rect.height);  foff=0;
			}
			var rct = {x:rUi(data, offset+12),y:rUi(data, offset+16),width:rUi(data, offset+4),height:rUi(data, offset+8)};
			var del = rUs(data, offset+22);  del = rUs(data, offset+20) / (del==0?100:del);
			var frm = {rect:rct, delay:Math.round(del*1000), dispose:data[offset+24], blend:data[offset+25]};
			//console.log(frm);
			out.frames.push(frm);
		}
		else if(type=="fdAT") {
			for(var i=0; i<len-4; i++) fd[foff+i] = data[offset+i+4];
			foff += len-4;
		}
		else if(type=="pHYs") {
			out.tabs[type] = [bin.readUint(data, offset), bin.readUint(data, offset+4), data[offset+8]];
		}
		else if(type=="cHRM") {
			out.tabs[type] = [];
			for(var i=0; i<8; i++) out.tabs[type].push(bin.readUint(data, offset+i*4));
		}
		else if(type=="tEXt") {
			if(out.tabs[type]==null) out.tabs[type] = {};
			var nz = bin.nextZero(data, offset);
			var keyw = bin.readASCII(data, offset, nz-offset);
			var text = bin.readASCII(data, nz+1, offset+len-nz-1);
			out.tabs[type][keyw] = text;
		}
		else if(type=="iTXt") {
			if(out.tabs[type]==null) out.tabs[type] = {};
			var nz = 0, off = offset;
			nz = bin.nextZero(data, off);
			var keyw = bin.readASCII(data, off, nz-off);  off = nz + 1;
			var cflag = data[off], cmeth = data[off+1];  off+=2;
			nz = bin.nextZero(data, off);
			var ltag = bin.readASCII(data, off, nz-off);  off = nz + 1;
			nz = bin.nextZero(data, off);
			var tkeyw = bin.readUTF8(data, off, nz-off);  off = nz + 1;
			var text  = bin.readUTF8(data, off, len-(off-offset));
			out.tabs[type][keyw] = text;
		}
		else if(type=="PLTE") {
			out.tabs[type] = bin.readBytes(data, offset, len);
		}
		else if(type=="hIST") {
			var pl = out.tabs["PLTE"].length/3;
			out.tabs[type] = [];  for(var i=0; i<pl; i++) out.tabs[type].push(rUs(data, offset+i*2));
		}
		else if(type=="tRNS") {
			if     (out.ctype==3) out.tabs[type] = bin.readBytes(data, offset, len);
			else if(out.ctype==0) out.tabs[type] = rUs(data, offset);
			else if(out.ctype==2) out.tabs[type] = [ rUs(data,offset),rUs(data,offset+2),rUs(data,offset+4) ];
			//else console.log("tRNS for unsupported color type",out.ctype, len);
		}
		else if(type=="gAMA") out.tabs[type] = bin.readUint(data, offset)/100000;
		else if(type=="sRGB") out.tabs[type] = data[offset];
		else if(type=="bKGD")
		{
			if     (out.ctype==0 || out.ctype==4) out.tabs[type] = [rUs(data, offset)];
			else if(out.ctype==2 || out.ctype==6) out.tabs[type] = [rUs(data, offset), rUs(data, offset+2), rUs(data, offset+4)];
			else if(out.ctype==3) out.tabs[type] = data[offset];
		}
		else if(type=="IEND") {
			break;
		}
		//else {  log("unknown chunk type", type, len);  }
		offset += len;
		var crc = bin.readUint(data, offset);  offset += 4;
	}
	if(foff!=0) {  var fr = out.frames[out.frames.length-1];
		fr.data = UPNG.decode._decompress(out, fd.slice(0,foff), fr.rect.width, fr.rect.height);  foff=0;
	}	
	out.data = UPNG.decode._decompress(out, dd, out.width, out.height);
	
	delete out.compress;  delete out.interlace;  delete out.filter;
	return out;
}

UPNG.decode._decompress = function(out, dd, w, h) {
	if(out.compress ==0) dd = UPNG.decode._inflate(dd);

	if     (out.interlace==0) dd = UPNG.decode._filterZero(dd, out, 0, w, h);
	else if(out.interlace==1) dd = UPNG.decode._readInterlace(dd, out);
	return dd;
}

UPNG.decode._inflate = function(data) {  return pako["inflate"](data);  }

UPNG.decode._readInterlace = function(data, out)
{
	var w = out.width, h = out.height;
	var bpp = UPNG.decode._getBPP(out), cbpp = bpp>>3, bpl = Math.ceil(w*bpp/8);
	var img = new Uint8Array( h * bpl );
	var di = 0;

	var starting_row  = [ 0, 0, 4, 0, 2, 0, 1 ];
	var starting_col  = [ 0, 4, 0, 2, 0, 1, 0 ];
	var row_increment = [ 8, 8, 8, 4, 4, 2, 2 ];
	var col_increment = [ 8, 8, 4, 4, 2, 2, 1 ];

	var pass=0;
	while(pass<7)
	{
		var ri = row_increment[pass], ci = col_increment[pass];
		var sw = 0, sh = 0;
		var cr = starting_row[pass];  while(cr<h) {  cr+=ri;  sh++;  }
		var cc = starting_col[pass];  while(cc<w) {  cc+=ci;  sw++;  }
		var bpll = Math.ceil(sw*bpp/8);
		UPNG.decode._filterZero(data, out, di, sw, sh);

		var y=0, row = starting_row[pass];
		while(row<h)
		{
			var col = starting_col[pass];
			var cdi = (di+y*bpll)<<3;

			while(col<w)
			{
				if(bpp==1) {
					var val = data[cdi>>3];  val = (val>>(7-(cdi&7)))&1;
					img[row*bpl + (col>>3)] |= (val << (7-((col&3)<<0)));
				}
				if(bpp==2) {
					var val = data[cdi>>3];  val = (val>>(6-(cdi&7)))&3;
					img[row*bpl + (col>>2)] |= (val << (6-((col&3)<<1)));
				}
				if(bpp==4) {
					var val = data[cdi>>3];  val = (val>>(4-(cdi&7)))&15;
					img[row*bpl + (col>>1)] |= (val << (4-((col&1)<<2)));
				}
				if(bpp>=8) {
					var ii = row*bpl+col*cbpp;
					for(var j=0; j<cbpp; j++) img[ii+j] = data[(cdi>>3)+j];
				}
				cdi+=bpp;  col+=ci;
			}
			y++;  row += ri;
		}
		if(sw*sh!=0) di += sh * (1 + bpll);
		pass = pass + 1;
	}
	return img;
}

UPNG.decode._getBPP = function(out) {
	var noc = [1,null,3,1,2,null,4][out.ctype];
	return noc * out.depth;
}

UPNG.decode._filterZero = function(data, out, off, w, h)
{
	var bpp = UPNG.decode._getBPP(out), bpl = Math.ceil(w*bpp/8), paeth = UPNG.decode._paeth;
	bpp = Math.ceil(bpp/8);

	for(var y=0; y<h; y++)  {
		var i = off+y*bpl, di = i+y+1;
		var type = data[di-1];

		if     (type==0) for(var x=  0; x<bpl; x++) data[i+x] = data[di+x];
		else if(type==1) {
			for(var x=  0; x<bpp; x++) data[i+x] = data[di+x];
			for(var x=bpp; x<bpl; x++) data[i+x] = (data[di+x] + data[i+x-bpp])&255;
		}
		else if(y==0) {
			for(var x=  0; x<bpp; x++) data[i+x] = data[di+x];
			if(type==2) for(var x=bpp; x<bpl; x++) data[i+x] = (data[di+x])&255;
			if(type==3) for(var x=bpp; x<bpl; x++) data[i+x] = (data[di+x] + (data[i+x-bpp]>>1) )&255;
			if(type==4) for(var x=bpp; x<bpl; x++) data[i+x] = (data[di+x] + paeth(data[i+x-bpp], 0, 0) )&255;
		}
		else {
			if(type==2) { for(var x=  0; x<bpl; x++) data[i+x] = (data[di+x] + data[i+x-bpl])&255;  }

			if(type==3) { for(var x=  0; x<bpp; x++) data[i+x] = (data[di+x] + (data[i+x-bpl]>>1))&255;
			              for(var x=bpp; x<bpl; x++) data[i+x] = (data[di+x] + ((data[i+x-bpl]+data[i+x-bpp])>>1) )&255;  }

			if(type==4) { for(var x=  0; x<bpp; x++) data[i+x] = (data[di+x] + paeth(0, data[i+x-bpl], 0))&255;
						  for(var x=bpp; x<bpl; x++) data[i+x] = (data[di+x] + paeth(data[i+x-bpp], data[i+x-bpl], data[i+x-bpp-bpl]) )&255;  }
		}
	}
	return data;
}

UPNG.decode._paeth = function(a,b,c)
{
	var p = a+b-c, pa = Math.abs(p-a), pb = Math.abs(p-b), pc = Math.abs(p-c);
	if (pa <= pb && pa <= pc)  return a;
	else if (pb <= pc)  return b;
	return c;
}

UPNG.decode._IHDR = function(data, offset, out)
{
	var bin = UPNG._bin;
	out.width  = bin.readUint(data, offset);  offset += 4;
	out.height = bin.readUint(data, offset);  offset += 4;
	out.depth     = data[offset];  offset++;
	out.ctype     = data[offset];  offset++;
	out.compress  = data[offset];  offset++;
	out.filter    = data[offset];  offset++;
	out.interlace = data[offset];  offset++;
}

UPNG._bin = {
	nextZero   : function(data,p)  {  while(data[p]!=0) p++;  return p;  },
	readUshort : function(buff,p)  {  return (buff[p]<< 8) | buff[p+1];  },
	writeUshort: function(buff,p,n){  buff[p] = (n>>8)&255;  buff[p+1] = n&255;  },
	readUint   : function(buff,p)  {  return (buff[p]*(256*256*256)) + ((buff[p+1]<<16) | (buff[p+2]<< 8) | buff[p+3]);  },
	writeUint  : function(buff,p,n){  buff[p]=(n>>24)&255;  buff[p+1]=(n>>16)&255;  buff[p+2]=(n>>8)&255;  buff[p+3]=n&255;  },
	readASCII  : function(buff,p,l){  var s = "";  for(var i=0; i<l; i++) s += String.fromCharCode(buff[p+i]);  return s;    },
	writeASCII : function(data,p,s){  for(var i=0; i<s.length; i++) data[p+i] = s.charCodeAt(i);  },
	readBytes  : function(buff,p,l){  var arr = [];   for(var i=0; i<l; i++) arr.push(buff[p+i]);   return arr;  },
	pad : function(n) { return n.length < 2 ? "0" + n : n; },
	readUTF8 : function(buff, p, l) {
		var s = "", ns;
		for(var i=0; i<l; i++) s += "%" + UPNG._bin.pad(buff[p+i].toString(16));
		try {  ns = decodeURIComponent(s); }
		catch(e) {  return UPNG._bin.readASCII(buff, p, l);  }
		return  ns;
	}
}
UPNG._copyTile = function(sb, sw, sh, tb, tw, th, xoff, yoff, mode)
{
	var w = Math.min(sw,tw), h = Math.min(sh,th);
	var si=0, ti=0;
	for(var y=0; y<h; y++)
		for(var x=0; x<w; x++)
		{
			if(xoff>=0 && yoff>=0) {  si = (y*sw+x)<<2;  ti = (( yoff+y)*tw+xoff+x)<<2;  }
			else                   {  si = ((-yoff+y)*sw-xoff+x)<<2;  ti = (y*tw+x)<<2;  }
			
			if     (mode==0) {  tb[ti] = sb[si];  tb[ti+1] = sb[si+1];  tb[ti+2] = sb[si+2];  tb[ti+3] = sb[si+3];  }
			else if(mode==1) {
				var fa = sb[si+3]*(1/255), fr=sb[si]*fa, fg=sb[si+1]*fa, fb=sb[si+2]*fa; 
				var ba = tb[ti+3]*(1/255), br=tb[ti]*ba, bg=tb[ti+1]*ba, bb=tb[ti+2]*ba; 
				
				var ifa=1-fa, oa = fa+ba*ifa, ioa = (oa==0?0:1/oa);
				tb[ti+3] = 255*oa;  
				tb[ti+0] = (fr+br*ifa)*ioa;  
				tb[ti+1] = (fg+bg*ifa)*ioa;   
				tb[ti+2] = (fb+bb*ifa)*ioa;  
			}
			else if(mode==2){	// copy only differences, otherwise zero
				var fa = sb[si+3], fr=sb[si], fg=sb[si+1], fb=sb[si+2]; 
				var ba = tb[ti+3], br=tb[ti], bg=tb[ti+1], bb=tb[ti+2]; 
				if(fa==ba && fr==br && fg==bg && fb==bb) {  tb[ti]=0;  tb[ti+1]=0;  tb[ti+2]=0;  tb[ti+3]=0;  }
				else {  tb[ti]=fr;  tb[ti+1]=fg;  tb[ti+2]=fb;  tb[ti+3]=fa;  }
			}
			else if(mode==3){	// check if can be blended
				var fa = sb[si+3], fr=sb[si], fg=sb[si+1], fb=sb[si+2]; 
				var ba = tb[ti+3], br=tb[ti], bg=tb[ti+1], bb=tb[ti+2]; 
				if(fa==ba && fr==br && fg==bg && fb==bb) continue;
				//if(fa!=255 && ba!=0) return false;
				if(fa<220 && ba>20) return false;
			}
		}
	return true;
}


UPNG.encode = function(bufs, w, h, ps, dels, forbidPlte)
{
	if(ps==null) ps=0;
	if(forbidPlte==null) forbidPlte = false;
	var data = new Uint8Array(bufs[0].byteLength*bufs.length+100);
	var wr=[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	for(var i=0; i<8; i++) data[i]=wr[i];
	var offset = 8,  bin = UPNG._bin, crc = UPNG.crc.crc, wUi = bin.writeUint, wUs = bin.writeUshort, wAs = bin.writeASCII;

	var nimg = UPNG.encode.compressPNG(bufs, w, h, ps, forbidPlte);

	wUi(data,offset, 13);     offset+=4;
	wAs(data,offset,"IHDR");  offset+=4;
	wUi(data,offset,w);  offset+=4;
	wUi(data,offset,h);  offset+=4;
	data[offset] = nimg.depth;  offset++;  // depth
	data[offset] = nimg.ctype;  offset++;  // ctype
	data[offset] = 0;  offset++;  // compress
	data[offset] = 0;  offset++;  // filter
	data[offset] = 0;  offset++;  // interlace
	wUi(data,offset,crc(data,offset-17,17));  offset+=4; // crc

	// 9 bytes to say, that it is sRGB
	wUi(data,offset, 1);      offset+=4;
	wAs(data,offset,"sRGB");  offset+=4;
	data[offset] = 1;  offset++;
	wUi(data,offset,crc(data,offset-5,5));  offset+=4; // crc

	var anim = bufs.length>1;
	if(anim) {
		wUi(data,offset, 8);      offset+=4;
		wAs(data,offset,"acTL");  offset+=4;
		wUi(data,offset, bufs.length);      offset+=4;
		wUi(data,offset, 0);      offset+=4;
		wUi(data,offset,crc(data,offset-12,12));  offset+=4; // crc
	}

	if(nimg.ctype==3) {
		var dl = nimg.plte.length;
		wUi(data,offset, dl*3);  offset+=4;
		wAs(data,offset,"PLTE");  offset+=4;
		for(var i=0; i<dl; i++){
			var ti=i*3, c=nimg.plte[i], r=(c)&255, g=(c>>8)&255, b=(c>>16)&255;
			data[offset+ti+0]=r;  data[offset+ti+1]=g;  data[offset+ti+2]=b;
		}
		offset+=dl*3;
		wUi(data,offset,crc(data,offset-dl*3-4,dl*3+4));  offset+=4; // crc

		if(nimg.gotAlpha) {
			wUi(data,offset, dl);  offset+=4;
			wAs(data,offset,"tRNS");  offset+=4;
			for(var i=0; i<dl; i++)  data[offset+i]=(nimg.plte[i]>>24)&255;
			offset+=dl;
			wUi(data,offset,crc(data,offset-dl-4,dl+4));  offset+=4; // crc
		}
	}
	
	var fi = 0;
	for(var j=0; j<nimg.frames.length; j++)
	{
		var fr = nimg.frames[j];
		if(anim) {
			wUi(data,offset, 26);     offset+=4;
			wAs(data,offset,"fcTL");  offset+=4;
			wUi(data, offset, fi++);   offset+=4;
			wUi(data, offset, fr.rect.width );   offset+=4;
			wUi(data, offset, fr.rect.height);   offset+=4;
			wUi(data, offset, fr.rect.x);   offset+=4;
			wUi(data, offset, fr.rect.y);   offset+=4;
			wUs(data, offset, dels[j]);   offset+=2;
			wUs(data, offset,  1000);   offset+=2;
			data[offset] = fr.dispose;  offset++;	// dispose
			data[offset] = fr.blend  ;  offset++;	// blend
			wUi(data,offset,crc(data,offset-30,30));  offset+=4; // crc
		}
				
		var imgd = fr.cimg, dl = imgd.length;
		wUi(data,offset, dl+(j==0?0:4));     offset+=4;
		var ioff = offset;
		wAs(data,offset,(j==0)?"IDAT":"fdAT");  offset+=4;
		if(j!=0) {  wUi(data, offset, fi++);  offset+=4;  }
		for(var i=0; i<dl; i++) data[offset+i] = imgd[i];
		offset += dl;
		wUi(data,offset,crc(data,ioff,offset-ioff));  offset+=4; // crc
	}

	wUi(data,offset, 0);     offset+=4;
	wAs(data,offset,"IEND");  offset+=4;
	wUi(data,offset,crc(data,offset-4,4));  offset+=4; // crc

	return data.buffer.slice(0,offset);
}

UPNG.encode.compressPNG = function(bufs, w, h, ps, forbidPlte)
{
	var out = UPNG.encode.compress(bufs, w, h, ps, false, forbidPlte);
	for(var i=0; i<bufs.length; i++) {
		var frm = out.frames[i], nw=frm.rect.width, nh=frm.rect.height, bpl=frm.bpl, bpp=frm.bpp;
		var fdata = new Uint8Array(nh*bpl+nh);
		frm.cimg = UPNG.encode._filterZero(frm.img,nh,bpp,bpl,fdata);
	}	
	return out;
}



UPNG.encode.compress = function(bufs, w, h, ps, forGIF, forbidPlte)
{
	//var time = Date.now();
	if(forbidPlte==null) forbidPlte = false;
	
	var ctype = 6, depth = 8, alphaAnd=255
	
	for(var j=0; j<bufs.length; j++)  {  // when not quantized, other frames can contain colors, that are not in an initial frame
		var img = new Uint8Array(bufs[j]), ilen = img.length;
		for(var i=0; i<ilen; i+=4) alphaAnd &= img[i+3];
	}
	var gotAlpha = (alphaAnd!=255);
	
	//console.log("alpha check", Date.now()-time);  time = Date.now();
	
	var brute = gotAlpha && forGIF;		// brute : frames can only be copied, not "blended"
	var frms = UPNG.encode.framize(bufs, w, h, forGIF, brute);
	//console.log("framize", Date.now()-time);  time = Date.now();
	
	var cmap={}, plte=[], inds=[];  
	
	if(ps!=0) {
		var nbufs = [];  for(var i=0; i<frms.length; i++) nbufs.push(frms[i].img.buffer);
		
		var abuf = UPNG.encode.concatRGBA(nbufs, forGIF), qres = UPNG.quantize(abuf, ps);  
		var cof = 0, bb = new Uint8Array(qres.abuf);
		for(var i=0; i<frms.length; i++) {  var ti=frms[i].img, bln=ti.length;  inds.push(new Uint8Array(qres.inds.buffer, cof>>2, bln>>2));
			for(var j=0; j<bln; j+=4) {  ti[j]=bb[cof+j];  ti[j+1]=bb[cof+j+1];  ti[j+2]=bb[cof+j+2];  ti[j+3]=bb[cof+j+3];  }    cof+=bln;  }
		
		for(var i=0; i<qres.plte.length; i++) plte.push(qres.plte[i].est.rgba);
		//console.log("quantize", Date.now()-time);  time = Date.now();
	}
	else {
		// what if ps==0, but there are <=256 colors?  we still need to detect, if the palette could be used
		for(var j=0; j<frms.length; j++)  {  // when not quantized, other frames can contain colors, that are not in an initial frame
			var frm = frms[j], img32 = new Uint32Array(frm.img.buffer), nw=frm.rect.width, ilen = img32.length;
			var ind = new Uint8Array(ilen);  inds.push(ind);
			for(var i=0; i<ilen; i++) {
				var c = img32[i];
				if     (i!=0 && c==img32[i- 1]) ind[i]=ind[i-1];
				else if(i>nw && c==img32[i-nw]) ind[i]=ind[i-nw];
				else {
					var cmc = cmap[c];
					if(cmc==null) {  cmap[c]=cmc=plte.length;  plte.push(c);  if(plte.length>=300) break;  }
					ind[i]=cmc;
				}
			}
		}
		//console.log("make palette", Date.now()-time);  time = Date.now();
	}
	
	var cc=plte.length; //console.log("colors:",cc);
	if(cc<=256 && forbidPlte==false) {
		if(cc<= 2) depth=1;  else if(cc<= 4) depth=2;  else if(cc<=16) depth=4;  else depth=8;
		if(forGIF) depth=8;
		gotAlpha = true;
	}
	
	for(var j=0; j<frms.length; j++)
	{
		var frm = frms[j], nx=frm.rect.x, ny=frm.rect.y, nw=frm.rect.width, nh=frm.rect.height;
		var cimg = frm.img, cimg32 = new Uint32Array(cimg.buffer);
		var bpl = 4*nw, bpp=4;
		if(cc<=256 && forbidPlte==false) {
			bpl = Math.ceil(depth*nw/8);
			var nimg = new Uint8Array(bpl*nh);
			var inj = inds[j];
			for(var y=0; y<nh; y++) {  var i=y*bpl, ii=y*nw;
				if     (depth==8) for(var x=0; x<nw; x++) nimg[i+(x)   ]   =  (inj[ii+x]             );
				else if(depth==4) for(var x=0; x<nw; x++) nimg[i+(x>>1)]  |=  (inj[ii+x]<<(4-(x&1)*4));
				else if(depth==2) for(var x=0; x<nw; x++) nimg[i+(x>>2)]  |=  (inj[ii+x]<<(6-(x&3)*2));
				else if(depth==1) for(var x=0; x<nw; x++) nimg[i+(x>>3)]  |=  (inj[ii+x]<<(7-(x&7)*1));
			}
			cimg=nimg;  ctype=3;  bpp=1;
		}
		else if(gotAlpha==false && frms.length==1) {	// some next "reduced" frames may contain alpha for blending
			var nimg = new Uint8Array(nw*nh*3), area=nw*nh;
			for(var i=0; i<area; i++) { var ti=i*3, qi=i*4;  nimg[ti]=cimg[qi];  nimg[ti+1]=cimg[qi+1];  nimg[ti+2]=cimg[qi+2];  }
			cimg=nimg;  ctype=2;  bpp=3;  bpl=3*nw;
		}
		frm.img=cimg;  frm.bpl=bpl;  frm.bpp=bpp;
	}
	//console.log("colors => palette indices", Date.now()-time);  time = Date.now();
	
	return {ctype:ctype, depth:depth, plte:plte, gotAlpha:gotAlpha, frames:frms  };
}
UPNG.encode.framize = function(bufs,w,h,forGIF,brute) {
	var frms = [];
	for(var j=0; j<bufs.length; j++) {
		var cimg = new Uint8Array(bufs[j]), cimg32 = new Uint32Array(cimg.buffer);
		
		var nx=0, ny=0, nw=w, nh=h, blend=0;
		if(j!=0 && !brute) {
			var tlim = (forGIF || j==1 || frms[frms.length-2].dispose==2)?1:2, tstp = 0, tarea = 1e9;
			for(var it=0; it<tlim; it++)
			{
				var pimg = new Uint8Array(bufs[j-1-it]), p32 = new Uint32Array(bufs[j-1-it]);
				var mix=w,miy=h,max=-1,may=-1;
				for(var y=0; y<h; y++) for(var x=0; x<w; x++) {
					var i = y*w+x;
					if(cimg32[i]!=p32[i]) {
						if(x<mix) mix=x;  if(x>max) max=x;
						if(y<miy) miy=y;  if(y>may) may=y;
					}
				}
				var sarea = (max==-1) ? 1 : (max-mix+1)*(may-miy+1);
				if(sarea<tarea) {
					tarea = sarea;  tstp = it;  
					if(max==-1) {  nx=ny=0;  nw=nh=1;  }
					else {  nx = mix; ny = miy; nw = max-mix+1; nh = may-miy+1;  }
				}
			}
			
			var pimg = new Uint8Array(bufs[j-1-tstp]);
			if(tstp==1) frms[frms.length-1].dispose = 2;
			
			var nimg = new Uint8Array(nw*nh*4), nimg32 = new Uint32Array(nimg.buffer);
			UPNG.   _copyTile(pimg,w,h, nimg,nw,nh, -nx,-ny, 0);
			if(UPNG._copyTile(cimg,w,h, nimg,nw,nh, -nx,-ny, 3)) {
				UPNG._copyTile(cimg,w,h, nimg,nw,nh, -nx,-ny, 2);  blend = 1;
			}
			else {
				UPNG._copyTile(cimg,w,h, nimg,nw,nh, -nx,-ny, 0);  blend = 0;
			}
			cimg = nimg;
		}
		else cimg = cimg.slice(0);	// img may be rewrited further ... don't rewrite input
		frms.push({rect:{x:nx,y:ny,width:nw,height:nh}, img:cimg, blend:blend, dispose:brute?1:0});
	}
	return frms;
}

UPNG.encode._filterZero = function(img,h,bpp,bpl,data)
{
	var fls = [];
	for(var t=0; t<5; t++) {  if(h*bpl>500000 && (t==2 || t==3 || t==4)) continue;
		for(var y=0; y<h; y++) UPNG.encode._filterLine(data, img, y, bpl, bpp, t);
		fls.push(pako["deflate"](data));  if(bpp==1) break;
	}
	var ti, tsize=1e9;
	for(var i=0; i<fls.length; i++) if(fls[i].length<tsize) {  ti=i;  tsize=fls[i].length;  }
	return fls[ti];
}
UPNG.encode._filterLine = function(data, img, y, bpl, bpp, type)
{
	var i = y*bpl, di = i+y, paeth = UPNG.decode._paeth
	data[di]=type;  di++;

	if(type==0) for(var x=0; x<bpl; x++) data[di+x] = img[i+x];
	else if(type==1) {
		for(var x=  0; x<bpp; x++) data[di+x] =  img[i+x];
		for(var x=bpp; x<bpl; x++) data[di+x] = (img[i+x]-img[i+x-bpp]+256)&255;
	}
	else if(y==0) {
		for(var x=  0; x<bpp; x++) data[di+x] = img[i+x];

		if(type==2) for(var x=bpp; x<bpl; x++) data[di+x] = img[i+x];
		if(type==3) for(var x=bpp; x<bpl; x++) data[di+x] = (img[i+x] - (img[i+x-bpp]>>1) +256)&255;
		if(type==4) for(var x=bpp; x<bpl; x++) data[di+x] = (img[i+x] - paeth(img[i+x-bpp], 0, 0) +256)&255;
	}
	else {
		if(type==2) { for(var x=  0; x<bpl; x++) data[di+x] = (img[i+x]+256 - img[i+x-bpl])&255;  }
		if(type==3) { for(var x=  0; x<bpp; x++) data[di+x] = (img[i+x]+256 - (img[i+x-bpl]>>1))&255;
					  for(var x=bpp; x<bpl; x++) data[di+x] = (img[i+x]+256 - ((img[i+x-bpl]+img[i+x-bpp])>>1))&255;  }
		if(type==4) { for(var x=  0; x<bpp; x++) data[di+x] = (img[i+x]+256 - paeth(0, img[i+x-bpl], 0))&255;
					  for(var x=bpp; x<bpl; x++) data[di+x] = (img[i+x]+256 - paeth(img[i+x-bpp], img[i+x-bpl], img[i+x-bpp-bpl]))&255;  }
	}
}

UPNG.crc = {
	table : ( function() {
	   var tab = new Uint32Array(256);
	   for (var n=0; n<256; n++) {
			var c = n;
			for (var k=0; k<8; k++) {
				if (c & 1)  c = 0xedb88320 ^ (c >>> 1);
				else        c = c >>> 1;
			}
			tab[n] = c;  }
		return tab;  })(),
	update : function(c, buf, off, len) {
		for (var i=0; i<len; i++)  c = UPNG.crc.table[(c ^ buf[off+i]) & 0xff] ^ (c >>> 8);
		return c;
	},
	crc : function(b,o,l)  {  return UPNG.crc.update(0xffffffff,b,o,l) ^ 0xffffffff;  }
}


UPNG.quantize = function(abuf, ps)
{	
	var oimg = new Uint8Array(abuf), nimg = oimg.slice(0), nimg32 = new Uint32Array(nimg.buffer);
	
	var KD = UPNG.quantize.getKDtree(nimg, ps);
	var root = KD[0], leafs = KD[1];
	
	var planeDst = UPNG.quantize.planeDst;
	var sb = oimg, tb = nimg32, len=sb.length;
		
	var inds = new Uint8Array(oimg.length>>2);
	for(var i=0; i<len; i+=4) {
		var r=sb[i]*(1/255), g=sb[i+1]*(1/255), b=sb[i+2]*(1/255), a=sb[i+3]*(1/255);
		
		//  exact, but too slow :(
		var nd = UPNG.quantize.getNearest(root, r, g, b, a);
		//var nd = root;
		//while(nd.left) nd = (planeDst(nd.est,r,g,b,a)<=0) ? nd.left : nd.right;
		
		inds[i>>2] = nd.ind;
		tb[i>>2] = nd.est.rgba;
	}
	return {  abuf:nimg.buffer, inds:inds, plte:leafs  };
}

UPNG.quantize.getKDtree = function(nimg, ps, err) {
	if(err==null) err = 0.0001;
	var nimg32 = new Uint32Array(nimg.buffer);
	
	var root = {i0:0, i1:nimg.length, bst:null, est:null, tdst:0, left:null, right:null };  // basic statistic, extra statistic
	root.bst = UPNG.quantize.stats(  nimg,root.i0, root.i1  );  root.est = UPNG.quantize.estats( root.bst );
	var leafs = [root];
	
	while(leafs.length<ps)
	{
		var maxL = 0, mi=0;
		for(var i=0; i<leafs.length; i++) if(leafs[i].est.L > maxL) {  maxL=leafs[i].est.L;  mi=i;  }
		if(maxL<err) break;
		var node = leafs[mi];
		
		var s0 = UPNG.quantize.splitPixels(nimg,nimg32, node.i0, node.i1, node.est.e, node.est.eMq255);
		var s0wrong = (node.i0>=s0 || node.i1<=s0);
		//console.log(maxL, leafs.length, mi);
		if(s0wrong) {  node.est.L=0;  continue;  }
		
		
		var ln = {i0:node.i0, i1:s0, bst:null, est:null, tdst:0, left:null, right:null };  ln.bst = UPNG.quantize.stats( nimg, ln.i0, ln.i1 );  
		ln.est = UPNG.quantize.estats( ln.bst );
		var rn = {i0:s0, i1:node.i1, bst:null, est:null, tdst:0, left:null, right:null };  rn.bst = {R:[], m:[], N:node.bst.N-ln.bst.N};
		for(var i=0; i<16; i++) rn.bst.R[i] = node.bst.R[i]-ln.bst.R[i];
		for(var i=0; i< 4; i++) rn.bst.m[i] = node.bst.m[i]-ln.bst.m[i];
		rn.est = UPNG.quantize.estats( rn.bst );
		
		node.left = ln;  node.right = rn;
		leafs[mi]=ln;  leafs.push(rn);
	}
	leafs.sort(function(a,b) {  return b.bst.N-a.bst.N;  });
	for(var i=0; i<leafs.length; i++) leafs[i].ind=i;
	return [root, leafs];
}

UPNG.quantize.getNearest = function(nd, r,g,b,a)
{
	if(nd.left==null) {  nd.tdst = UPNG.quantize.dist(nd.est.q,r,g,b,a);  return nd;  }
	var planeDst = UPNG.quantize.planeDst(nd.est,r,g,b,a);
	
	var node0 = nd.left, node1 = nd.right;
	if(planeDst>0) {  node0=nd.right;  node1=nd.left;  }
	
	var ln = UPNG.quantize.getNearest(node0, r,g,b,a);
	if(ln.tdst<=planeDst*planeDst) return ln;
	var rn = UPNG.quantize.getNearest(node1, r,g,b,a);
	return rn.tdst<ln.tdst ? rn : ln;
}
UPNG.quantize.planeDst = function(est, r,g,b,a) {  var e = est.e;  return e[0]*r + e[1]*g + e[2]*b + e[3]*a - est.eMq;  }
UPNG.quantize.dist     = function(q,   r,g,b,a) {  var d0=r-q[0], d1=g-q[1], d2=b-q[2], d3=a-q[3];  return d0*d0+d1*d1+d2*d2+d3*d3;  }

UPNG.quantize.splitPixels = function(nimg, nimg32, i0, i1, e, eMq)
{
	var vecDot = UPNG.quantize.vecDot;
	i1-=4;
	var shfs = 0;
	while(i0<i1)
	{
		while(vecDot(nimg, i0, e)<=eMq) i0+=4;
		while(vecDot(nimg, i1, e)> eMq) i1-=4;
		if(i0>=i1) break;
		
		var t = nimg32[i0>>2];  nimg32[i0>>2] = nimg32[i1>>2];  nimg32[i1>>2]=t;
		
		i0+=4;  i1-=4;
	}
	while(vecDot(nimg, i0, e)>eMq) i0-=4;
	return i0+4;
}
UPNG.quantize.vecDot = function(nimg, i, e)
{
	return nimg[i]*e[0] + nimg[i+1]*e[1] + nimg[i+2]*e[2] + nimg[i+3]*e[3];
}
UPNG.quantize.stats = function(nimg, i0, i1){
	var R = [0,0,0,0,  0,0,0,0,  0,0,0,0,  0,0,0,0];
	var m = [0,0,0,0];
	var N = (i1-i0)>>2;
	for(var i=i0; i<i1; i+=4)
	{
		var r = nimg[i]*(1/255), g = nimg[i+1]*(1/255), b = nimg[i+2]*(1/255), a = nimg[i+3]*(1/255);
		//var r = nimg[i], g = nimg[i+1], b = nimg[i+2], a = nimg[i+3];
		m[0]+=r;  m[1]+=g;  m[2]+=b;  m[3]+=a;
		
		R[ 0] += r*r;  R[ 1] += r*g;  R[ 2] += r*b;  R[ 3] += r*a;  
		               R[ 5] += g*g;  R[ 6] += g*b;  R[ 7] += g*a; 
		                              R[10] += b*b;  R[11] += b*a;  
		                                             R[15] += a*a;  
	}
	R[4]=R[1];  R[8]=R[2];  R[9]=R[6];  R[12]=R[3];  R[13]=R[7];  R[14]=R[11];
	
	return {R:R, m:m, N:N};
}
UPNG.quantize.estats = function(stats){
	var R = stats.R, m = stats.m, N = stats.N;
	
	// when all samples are equal, but N is large (millions), the Rj can be non-zero ( 0.0003.... - precission error)
	var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], iN = (N==0 ? 0 : 1/N);
	var Rj = [
		R[ 0] - m0*m0*iN,  R[ 1] - m0*m1*iN,  R[ 2] - m0*m2*iN,  R[ 3] - m0*m3*iN,  
		R[ 4] - m1*m0*iN,  R[ 5] - m1*m1*iN,  R[ 6] - m1*m2*iN,  R[ 7] - m1*m3*iN,
		R[ 8] - m2*m0*iN,  R[ 9] - m2*m1*iN,  R[10] - m2*m2*iN,  R[11] - m2*m3*iN,  
		R[12] - m3*m0*iN,  R[13] - m3*m1*iN,  R[14] - m3*m2*iN,  R[15] - m3*m3*iN 
	];
	
	var A = Rj, M = UPNG.M4;
	var b = [0.5,0.5,0.5,0.5], mi = 0, tmi = 0;
	
	if(N!=0)
	for(var i=0; i<10; i++) {
		b = M.multVec(A, b);  tmi = Math.sqrt(M.dot(b,b));  b = M.sml(1/tmi,  b);
		if(Math.abs(tmi-mi)<1e-9) break;  mi = tmi;
	}	
	//b = [0,0,1,0];  mi=N;
	var q = [m0*iN, m1*iN, m2*iN, m3*iN];
	var eMq255 = M.dot(M.sml(255,q),b);
	
	return {  Cov:Rj, q:q, e:b, L:mi,  eMq255:eMq255, eMq : M.dot(b,q),
				rgba: (((Math.round(255*q[3])<<24) | (Math.round(255*q[2])<<16) |  (Math.round(255*q[1])<<8) | (Math.round(255*q[0])<<0))>>>0)  };
}
UPNG.M4 = {
	multVec : function(m,v) {
			return [
				m[ 0]*v[0] + m[ 1]*v[1] + m[ 2]*v[2] + m[ 3]*v[3],
				m[ 4]*v[0] + m[ 5]*v[1] + m[ 6]*v[2] + m[ 7]*v[3],
				m[ 8]*v[0] + m[ 9]*v[1] + m[10]*v[2] + m[11]*v[3],
				m[12]*v[0] + m[13]*v[1] + m[14]*v[2] + m[15]*v[3]
			];
	},
	dot : function(x,y) {  return  x[0]*y[0]+x[1]*y[1]+x[2]*y[2]+x[3]*y[3];  },
	sml : function(a,y) {  return [a*y[0],a*y[1],a*y[2],a*y[3]];  }
}

UPNG.encode.concatRGBA = function(bufs, roundAlpha) {
	var tlen = 0;
	for(var i=0; i<bufs.length; i++) tlen += bufs[i].byteLength;
	var nimg = new Uint8Array(tlen), noff=0;
	for(var i=0; i<bufs.length; i++) {
		var img = new Uint8Array(bufs[i]), il = img.length;
		for(var j=0; j<il; j+=4) {  
			var r=img[j], g=img[j+1], b=img[j+2], a = img[j+3];
			if(roundAlpha)  a = (a&128)==0?0:255;
			if(a==0) r=g=b=0;
			nimg[noff+j]=r;  nimg[noff+j+1]=g;  nimg[noff+j+2]=b;  nimg[noff+j+3]=a;  }
		noff += il;
	}
	return nimg.buffer;
}
	
	
	UTEX = {}
	
	UTEX.readATC = function(data, offset, img, w, h)
	{
		var sqr = new Uint8Array(4*4*4);
		
		for(var y=0; y<h; y+=4)
			for(var x=0; x<w; x+=4)
			{
				UTEX.readATCcolor(data, offset, sqr);
				UTEX.write4x4(img, w, h, x, y, sqr);
				offset += 8;
			}
		return offset;
	}
	UTEX.readATA = function(data, offset, img, w, h)
	{
		var sqr = new Uint8Array(4*4*4);
		
		for(var y=0; y<h; y+=4)
			for(var x=0; x<w; x+=4) {
				UTEX.readATCcolor(data, offset+8, sqr);  
				/*
				for(var i=0; i<64; i+=4) {
					var code = UTEX.readBits(data, pos, 4);
					sqr[i+3] = 255*(code/15);
				}
				*/
				UTEX.write4x4(img, w, h, x, y, sqr);
				offset += 16;
			}
		return offset;
	}
	UTEX.readBC1 = function(data, offset, img, w, h)
	{
		var sqr = new Uint8Array(4*4*4);
		
		for(var y=0; y<h; y+=4)
			for(var x=0; x<w; x+=4)
			{
				UTEX.readBCcolor(data, offset, sqr);
				UTEX.write4x4(img, w, h, x, y, sqr);
				offset += 8;
			}
		return offset;
	}
	UTEX.writeBC1 = function(img, w, h, data, offset)
	{
		var sqr = new Uint8Array(16*4);
		for(var y=0; y<h; y+=4)
			for(var x=0; x<w; x+=4)
			{
				UTEX.read4x4(img,w,h,x,y,sqr);
				UTEX.writeBCcolor(data, offset, sqr);
				offset+=8;
			}
		return offset;
	}
	UTEX.readBC2 = function(data, offset, img, w, h)
	{
		var pos = {boff:offset*8};
		var sqr = new Uint8Array(4*4*4);
		
		for(var y=0; y<h; y+=4)
			for(var x=0; x<w; x+=4) {
				UTEX.readBCcolor(data, offset+8, sqr);  
				for(var i=0; i<64; i+=4) {
					var code = UTEX.readBits(data, pos, 4);
					sqr[i+3] = 255*(code/15);
				}
				UTEX.write4x4(img, w, h, x, y, sqr);
				offset += 16;  pos.boff+=64;
			}
		return offset;
	}
	
	UTEX.inter8 = function(a,b)
	{
		var al = [ a,b ];  
				
		if( a > b ) al.push(
			6/7*a + 1/7*b, // bit code 010
			5/7*a + 2/7*b, // bit code 011
			4/7*a + 3/7*b, // bit code 100
			3/7*a + 4/7*b, // bit code 101
			2/7*a + 5/7*b, // bit code 110
			1/7*a + 6/7*b  );
		else
			al.push(
			4/5*a + 1/5*b, // bit code 010
			3/5*a + 2/5*b, // bit code 011
			2/5*a + 3/5*b, // bit code 100
			1/5*a + 4/5*b, // bit code 101
			0,                     // bit code 110
			255            );
		return al;
	}
	
	UTEX.readBC3 = function(data, offset, img, w, h)
	{
		var pos = {boff:offset*8};
		var sqr = new Uint8Array(4*4*4);
		
		for(var y=0; y<h; y+=4)
			for(var x=0; x<w; x+=4)
			{				
				UTEX.readBCcolor(data, offset+8, sqr);
				
				var al = UTEX.inter8(data[offset], data[offset+1]);	pos.boff+=16;
				for(var i=0; i<64; i+=4) {
					var code = UTEX.readBits(data, pos, 3);
					sqr[i+3] = al[code];
				}
				pos.boff+=64;
				UTEX.write4x4(img, w, h, x, y, sqr);
				offset += 16;
			}
		return offset;
	}
	UTEX.writeBC3 = function(img, w, h, data, offset)
	{
		var sqr = new Uint8Array(16*4);
		for(var y=0; y<h; y+=4)
			for(var x=0; x<w; x+=4)
			{
				UTEX.read4x4(img,w,h,x,y,sqr);
				var min=sqr[3], max=sqr[3];
				for(var i=7; i<64; i+=4) {  var a = sqr[i];  if(a<min)min=a;  else if(max<a)max=a;  }
				data[offset]=max;  data[offset+1]=min;  offset+=2;
				
				var al = UTEX.inter8(max, min);
				var boff = (offset+2)<<3;
				for(var i=0; i<64; i+=32) {
					var bits=0, boff=0;
					for(var j=0; j<32; j+=4) {
						var code = 0, cd=500;
						var a=sqr[i+j+3];
						for(var k=0; k<8; k++) {  var dst=Math.abs(al[k]-a);  if(dst<cd) {  cd=dst;  code=k;  }  }
						bits = bits|(code<<boff);  boff+=3;
					}
					data[offset]=(bits);  data[offset+1]=(bits>>8);  data[offset+2]=(bits>>16);
					offset+=3;
				}
				
				UTEX.writeBCcolor(data, offset, sqr);
				offset+=8;
			}
		return offset;
	}
	
	UTEX._arr16 = new Uint8Array(16);
	UTEX.readATCcolor = function(data, offset, sqr)
	{		
		var c0 = (data[offset+1]<<8)|data[offset  ];
		var c1 = (data[offset+3]<<8)|data[offset+2];
		
		var c0b = (c0&31)*(255/31), c0g = ((c0>>>5)&31)*(255/31), c0r = (c0>>10)*(255/31);
		var c1b = (c1&31)*(255/31), c1g = ((c1>>>5)&63)*(255/63), c1r = (c1>>11)*(255/31);
		
		var clr = UTEX._arr16;
		clr[ 0] = ~~(c0r);  clr[ 1] = ~~(c0g);  clr[ 2] = ~~(c0b);  clr[ 3] = 255;
		clr[12] = ~~(c1r);  clr[13] = ~~(c1g);  clr[14] = ~~(c1b);  clr[15] = 255;
		var fr = 2/3, ifr = 1-fr;
		clr[ 4] = ~~(fr*c0r + ifr*c1r);  clr[ 5] = ~~(fr*c0g + ifr*c1g);  clr[ 6] = ~~(fr*c0b + ifr*c1b);  clr[ 7] = 255;
		fr = 1/3;  ifr=1-fr;
		clr[ 8] = ~~(fr*c0r + ifr*c1r);  clr[ 9] = ~~(fr*c0g + ifr*c1g);  clr[10] = ~~(fr*c0b + ifr*c1b);  clr[11] = 255;		
		
		UTEX.toSquare(data, sqr, clr, offset);
	}
	UTEX.readBCcolor = function(data, offset, sqr)
	{		
		var c0 = (data[offset+1]<<8)|data[offset  ];
		var c1 = (data[offset+3]<<8)|data[offset+2];
		
		var c0b = (c0&31)*(255/31), c0g = ((c0>>>5)&63)*(255/63), c0r = (c0>>11)*(255/31);
		var c1b = (c1&31)*(255/31), c1g = ((c1>>>5)&63)*(255/63), c1r = (c1>>11)*(255/31);
		
		var clr = UTEX._arr16;
		clr[0] = ~~(c0r);  clr[1] = ~~(c0g);  clr[2] = ~~(c0b);  clr[3] = 255;
		clr[4] = ~~(c1r);  clr[5] = ~~(c1g);  clr[6] = ~~(c1b);  clr[7] = 255;
		if(c1<c0) {
			var fr = 2/3, ifr = 1-fr;
			clr[ 8] = ~~(fr*c0r + ifr*c1r);  clr[ 9] = ~~(fr*c0g + ifr*c1g);  clr[10] = ~~(fr*c0b + ifr*c1b);  clr[11] = 255;
			fr = 1/3;  ifr=1-fr;
			clr[12] = ~~(fr*c0r + ifr*c1r);  clr[13] = ~~(fr*c0g + ifr*c1g);  clr[14] = ~~(fr*c0b + ifr*c1b);  clr[15] = 255;
		}
		else {
			var fr = 1/2, ifr = 1-fr;
			clr[ 8] = ~~(fr*c0r + ifr*c1r);  clr[ 9] = ~~(fr*c0g + ifr*c1g);  clr[10] = ~~(fr*c0b + ifr*c1b);  clr[11] = 255;
			clr[12] = 0;  clr[13] = 0;  clr[14] = 0;  clr[15] = 0;
		}
		UTEX.toSquare(data, sqr, clr, offset);
	}
	UTEX.writeBCcolor = function(data, offset, sqr) {
		var dist = UTEX.colorDist;
		var ends = UTEX.mostDistant(sqr);
		
		var c0r = sqr[(ends >>8)] , c0g = sqr[(ends >>8)+1] , c0b = sqr[(ends >>8)+2] ;
		var c1r = sqr[(ends&255)] , c1g = sqr[(ends&255)+1] , c1b = sqr[(ends&255)+2] ;
		
		var c0 =  ( ( c0r >> 3 ) << 11 ) | ( ( c0g >> 2 ) << 5 ) | ( c0b >> 3 ); 
		var c1 =  ( ( c1r >> 3 ) << 11 ) | ( ( c1g >> 2 ) << 5 ) | ( c1b >> 3 );
		if(c0<c1) {  var t=c0;  c0=c1;  c1=t;  }
		
		var c0b = Math.floor((c0&31)*(255/31)), c0g = Math.floor(((c0>>>5)&63)*(255/63)), c0r = Math.floor((c0>>11)*(255/31));
		var c1b = Math.floor((c1&31)*(255/31)), c1g = Math.floor(((c1>>>5)&63)*(255/63)), c1r = Math.floor((c1>>11)*(255/31));
		
		data[offset+0]=(c0&255);  data[offset+1] = (c0>>8);
		data[offset+2]=(c1&255);  data[offset+3] = (c1>>8);
		
		var fr = 2/3, ifr = 1-fr;
		var c2r = Math.floor(fr*c0r + ifr*c1r), c2g = Math.floor(fr*c0g + ifr*c1g), c2b = Math.floor(fr*c0b + ifr*c1b);
		fr = 1/3;  ifr=1-fr;
		var c3r = Math.floor(fr*c0r + ifr*c1r), c3g = Math.floor(fr*c0g + ifr*c1g), c3b = Math.floor(fr*c0b + ifr*c1b);
		
		
		var boff = offset*8+32;
		for(var i=0; i<64; i+=4) {
			var r=sqr[i], g=sqr[i+1], b=sqr[i+2];
			
			var ds0 = dist(r,g,b,c0r,c0g,c0b);
			var ds1 = dist(r,g,b,c1r,c1g,c1b);
			var ds2 = dist(r,g,b,c2r,c2g,c2b);
			var ds3 = dist(r,g,b,c3r,c3g,c3b);
			var dsm = Math.min(ds0, Math.min(ds1, Math.min(ds2, ds3)));
			
			var code=0;
			if(dsm==ds1) code=1;
			else if(dsm==ds2) code=2;
			else if(dsm==ds3) code=3;
			
			data[boff>>3] |= (code<<(boff&7));
			boff+=2;
		}
	}
	UTEX.toSquare = function(data, sqr, clr, offset)
	{
		var boff = (offset+4)<<3;
		for(var i=0; i<64; i+=4) {
			var code = ((data[boff>>3]>>((boff&7)))&3);  boff+=2;
			code = (code<<2);
			sqr[i  ] = clr[code  ];
			sqr[i+1] = clr[code+1];
			sqr[i+2] = clr[code+2];
			sqr[i+3] = clr[code+3];
		}
	}
	
	UTEX.read4x4 = function(a, w, h, sx,sy, b)	// read from large
	{
		for(var y=0; y<4; y++) {
			var si = ((sy+y)*w+sx)<<2, ti = y<<4;
			b[ti+ 0] = a[si+ 0];  b[ti+ 1] = a[si+ 1];  b[ti+ 2] = a[si+ 2];  b[ti+ 3] = a[si+ 3];
			b[ti+ 4] = a[si+ 4];  b[ti+ 5] = a[si+ 5];  b[ti+ 6] = a[si+ 6];  b[ti+ 7] = a[si+ 7];
			b[ti+ 8] = a[si+ 8];  b[ti+ 9] = a[si+ 9];  b[ti+10] = a[si+10];  b[ti+11] = a[si+11];
			b[ti+12] = a[si+12];  b[ti+13] = a[si+13];  b[ti+14] = a[si+14];  b[ti+15] = a[si+15];
		}
	}
	UTEX.write4x4 = function(a, w, h, sx,sy, b)	// write to large
	{
		for(var y=0; y<4; y++) {
			var si = ((sy+y)*w+sx)<<2, ti = y<<4;
			a[si+ 0] = b[ti+ 0];  a[si+ 1] = b[ti+ 1];  a[si+ 2] = b[ti+ 2];  a[si+ 3] = b[ti+ 3];
			a[si+ 4] = b[ti+ 4];  a[si+ 5] = b[ti+ 5];  a[si+ 6] = b[ti+ 6];  a[si+ 7] = b[ti+ 7];
			a[si+ 8] = b[ti+ 8];  a[si+ 9] = b[ti+ 9];  a[si+10] = b[ti+10];  a[si+11] = b[ti+11];
			a[si+12] = b[ti+12];  a[si+13] = b[ti+13];  a[si+14] = b[ti+14];  a[si+15] = b[ti+15];
		}
	}
	
	UTEX._subs2 = ["0011001100110011","0001000100010001","0111011101110111","0001001100110111","0000000100010011","0011011101111111","0001001101111111","0000000100110111","0000000000010011","0011011111111111","0000000101111111","0000000000010111","0001011111111111","0000000011111111","0000111111111111","0000000000001111","0000100011101111","0111000100000000","0000000010001110","0111001100010000","0011000100000000","0000100011001110","0000000010001100","0111001100110001","0011000100010000","0000100010001100","0110011001100110","0011011001101100","0001011111101000","0000111111110000","0111000110001110","0011100110011100","0101010101010101","0000111100001111","0101101001011010","0011001111001100","0011110000111100","0101010110101010","0110100101101001","0101101010100101","0111001111001110","0001001111001000","0011001001001100","0011101111011100","0110100110010110","0011110011000011","0110011010011001","0000011001100000","0100111001000000","0010011100100000","0000001001110010","0000010011100100","0110110010010011","0011011011001001","0110001110011100","0011100111000110","0110110011001001","0110001100111001","0111111010000001","0001100011100111","0000111100110011","0011001111110000","0010001011101110","0100010001110111"];
	UTEX._subs3 = ["0011001102212222","0001001122112221","0000200122112211","0222002200110111","0000000011221122","0011001100220022","0022002211111111","0011001122112211","0000000011112222","0000111111112222","0000111122222222","0012001200120012","0112011201120112","0122012201220122","0011011211221222","0011200122002220","0001001101121122","0111001120012200","0000112211221122","0022002200221111","0111011102220222","0001000122212221","0000001101220122","0000110022102210","0122012200110000","0012001211222222","0110122112210110","0000011012211221","0022110211020022","0110011020022222","0011012201220011","0000200022112221","0000000211221222","0222002200120011","0011001200220222","0120012001200120","0000111122220000","0120120120120120","0120201212010120","0011220011220011","0011112222000011","0101010122222222","0000000021212121","0022112200221122","0022001100220011","0220122102201221","0101222222220101","0000212121212121","0101010101012222","0222011102220111","0002111200021112","0000211221122112","0222011101110222","0002111211120002","0110011001102222","0000000021122112","0110011022222222","0022001100110022","0022112211220022","0000000000002112","0002000100020001","0222122202221222","0101222222222222","0111201122012220"]
	UTEX._anch2 = [[0,15,0],[0,15,0],[0,15,0],[0,15,0],[0,15,0],[0,15,0],[0,15,0],[0,15,0],[0,15,0],[0,15,0],[0,15,0],[0,15,0],[0,15,0],[0,15,0],[0,15,0],[0,15,0],[0,15,0],[0,2,0],[0,8,0],[0,2,0],[0,2,0],[0,8,0],[0,8,0],[0,15,0],[0,2,0],[0,8,0],[0,2,0],[0,2,0],[0,8,0],[0,8,0],[0,2,0],[0,2,0],[0,15,0],[0,15,0],[0,6,0],[0,8,0],[0,2,0],[0,8,0],[0,15,0],[0,15,0],[0,2,0],[0,8,0],[0,2,0],[0,2,0],[0,2,0],[0,15,0],[0,15,0],[0,6,0],[0,6,0],[0,2,0],[0,6,0],[0,8,0],[0,15,0],[0,15,0],[0,2,0],[0,2,0],[0,15,0],[0,15,0],[0,15,0],[0,15,0],[0,15,0],[0,2,0],[0,2,0],[0,15,0]];
	UTEX._anch3 = [[0,3,15],[0,3,8],[0,15,8],[0,15,3],[0,8,15],[0,3,15],[0,15,3],[0,15,8],[0,8,15],[0,8,15],[0,6,15],[0,6,15],[0,6,15],[0,5,15],[0,3,15],[0,3,8],[0,3,15],[0,3,8],[0,8,15],[0,15,3],[0,3,15],[0,3,8],[0,6,15],[0,10,8],[0,5,3],[0,8,15],[0,8,6],[0,6,10],[0,8,15],[0,5,15],[0,15,10],[0,15,8],[0,8,15],[0,15,3],[0,3,15],[0,5,10],[0,6,10],[0,10,8],[0,8,9],[0,15,10],[0,15,6],[0,3,15],[0,15,8],[0,5,15],[0,15,3],[0,15,6],[0,15,6],[0,15,8],[0,3,15],[0,15,3],[0,5,15],[0,5,15],[0,5,15],[0,8,15],[0,5,15],[0,10,15],[0,5,15],[0,10,15],[0,8,15],[0,13,15],[0,15,3],[0,12,15],[0,3,15],[0,3,8]];
	
	UTEX.readBC7 = function(data, offset, img, w, h)
	{
		var rB = UTEX.readBits;
		var pos = {boff:0};
		var sqr = new Uint8Array(4*4*4);
		
		var intp = [null,null,
			[0,21,43,64],
			[0,9,18,27,37,46,55,64],
			[0,4,9,13,17,21,26,30,34,38,43,47,51,55,60,64]
		];
		
		var subs = [ null, null, UTEX._subs2, UTEX._subs3 ];
		var ancs = [ null, null, UTEX._anch2, UTEX._anch3 ];
		
		for(var y=0; y<h; y+=4)
			for(var x=0; x<w; x+=4)
			{
				var mode = 0;
				while(((data[offset]>>mode)&1)!=1) mode++;
				
				pos.boff  = (offset<<3)+mode+1;
				
				var rot  = (mode==4 || mode==5) ? rB(data, pos, 2) : 0;
				var indx = (mode==4) ? rB(data, pos, 1) : 0;
				
				var prtlen = [4,6,6,6, 0,0,0,6][mode];
				var parti = rB(data, pos, prtlen);
				
				var clen = [4,6,5,7, 5,7,7,5][mode];
				var alen = [0,0,0,0, 6,8,7,5][mode];
				var plen = [1,1,0,1, 0,0,1,1][mode];
				var pnts = [6,4,6,4, 2,2,2,4][mode];
				
				var clr = [];
					
				for(var i=0; i<4; i++) {
					var len = i==3?alen:clen;
					for(var j=0; j<pnts; j++) clr[i*pnts+j] = rB(data, pos, len);
				}
				
				for(var j=0; j<pnts; j++) {
					if(mode==1 && ((j&1)==1)) pos.boff--;  // Ps shared per subset
					var bit = rB(data, pos, plen);
					for(var i=0; i<3; i++) clr[i*pnts+j] = (clr[i*pnts+j]<<plen)|bit;
					if(alen!=0) clr[3*pnts+j] = (clr[3*pnts+j]<<plen)|bit;
				}
				clen+=plen;  if(alen!=0) alen+=plen;
				
				for(var i=0; i<4; i++)
				{
					var len = i==3?alen:clen;
					var cf = len==0 ? 0 : 1/((1<<len)-1);
					for(var j=0; j<pnts; j++) clr[i*pnts+j] *= cf;
				}
				if(alen==0) for(var j=0; j<pnts; j++) clr[3*pnts+j] = 1;
				
				var scnt = [3,2,3,2, 1,1,1,2][mode];	// subset count
				var cind = [3,3,2,2, 2,2,4,2][mode];
				var aind = [0,0,0,0, 3,2,0,0][mode];
				
				var smap = "0000000000000000";
				var anci = [0,0,0];
				if(scnt!=1) {
					smap = subs[scnt][parti];
					anci = ancs[scnt][parti];
				}
				
				var coff = pos.boff;
				var aoff = coff + 16 * cind - scnt;
				if(indx==1) {  var t=coff;  coff=aoff;  aoff=t;  t=cind;  cind=aind;  aind=t;  }
				
				var cint = intp[cind];
				pos.boff = coff;
				
				for(var i=0; i<64; i+=4)
				{
					var ss = smap.charCodeAt(i>>2)-48;
					var first = anci[ss]==(i>>2) ? 1 : 0;
					var code = rB(data, pos, cind-first);
					
					var f = cint[code]/64;
					var r = (1-f)*clr[0*pnts + 2*ss + 0] + f*clr[0*pnts + 2*ss + 1];
					var g = (1-f)*clr[1*pnts + 2*ss + 0] + f*clr[1*pnts + 2*ss + 1];
					var b = (1-f)*clr[2*pnts + 2*ss + 0] + f*clr[2*pnts + 2*ss + 1];
					var a = (1-f)*clr[3*pnts + 2*ss + 0] + f*clr[3*pnts + 2*ss + 1];
					
					sqr[i  ] = r*255;
					sqr[i+1] = g*255;
					sqr[i+2] = b*255;
					sqr[i+3] = a*255;
				}
				
				cint = intp[aind];
				pos.boff = aoff;
				
				if(aind!=0) for(var i=0; i<64; i+=4)
				{
					var ss = smap.charCodeAt(i>>2)-48;
					var first = anci[ss]==(i>>2) ? 1 : 0;
					var code = rB(data, pos, aind-first);
					
					var f = cint[code]/64;
					var a = (1-f)*clr[3*pnts + 2*ss + 0] + f*clr[3*pnts + 2*ss + 1];
					sqr[i+3] = a*255;
				}
				
				
				UTEX.rotate(sqr, rot);
				UTEX.write4x4(img, w, h, x, y, sqr);
				
				offset += 16;
			}
		return offset;
	}
	UTEX.rotate = function(sqr, rot){
		if(rot==0) return;
		for(var i=0; i<64; i+=4)
		{
			var r=sqr[i  ];
			var g=sqr[i+1];
			var b=sqr[i+2];
			var a=sqr[i+3];
				
			if(rot==1) {  var t=a; a=r; r=t;  }
			if(rot==2) {  var t=a; a=g; g=t;  }
			if(rot==3) {  var t=a; a=b; b=t;  }
			
			sqr[i  ] = r;
			sqr[i+1] = g;
			sqr[i+2] = b;
			sqr[i+3] = a;
		}
	}
	
	UTEX.readBits = function(data, pos, k)
	{
		var out = 0, ok=k;
		while(k!=0) {  out = (out) | (UTEX.readBit(data, pos)<<(ok-k));  k--;  }
		return out;
	}
	UTEX.readBit = function(data, pos)
	{
		var boff = pos.boff;  pos.boff++;
		return ((data[boff>>3]>>((boff&7)))&1);
	}
	UTEX.mipmapB = function(buff, w, h)
	{
		var nw = w>>1, nh = h>>1;
		var nbuf = new Uint8Array(nw*nh*4);
		for(var y=0; y<nh; y++)
			for(var x=0; x<nw; x++) {
				var ti = (y*nw+x)<<2, si = ((y<<1)*w+(x<<1))<<2;
				//nbuf[ti  ] = buff[si  ];  nbuf[ti+1] = buff[si+1];  nbuf[ti+2] = buff[si+2];  nbuf[ti+3] = buff[si+3];
				//*
				var a0 = buff[si+3], a1 =  buff[si+7];
				var r = buff[si  ]*a0 + buff[si+4]*a1; 
				var g = buff[si+1]*a0 + buff[si+5]*a1;
				var b = buff[si+2]*a0 + buff[si+6]*a1;
				
				si+=(w<<2);
				
				var a2 = buff[si+3], a3 = buff[si+7];
				r    += buff[si  ]*a2 + buff[si+4]*a3;
				g    += buff[si+1]*a2 + buff[si+5]*a3;
				b    += buff[si+2]*a2 + buff[si+6]*a3;
				
				
				var a = (a0+a1+a2+a3+2)>>2, ia = (a==0) ? 0 : 0.25/a;
				nbuf[ti  ] = ~~(r*ia+0.5);
				nbuf[ti+1] = ~~(g*ia+0.5);
				nbuf[ti+2] = ~~(b*ia+0.5);
				nbuf[ti+3] = a;
			}
		return nbuf;
	}
	UTEX.colorDist = function(r,g,b, r0,g0,b0) {  return (r-r0)*(r-r0)+(g-g0)*(g-g0)+(b-b0)*(b-b0);  }
	
	UTEX.mostDistant = function(sqr)
	{
		var dist = UTEX.colorDist;
		var ends = 0, dd = 0;
		for(var i=0; i<64; i+=4) {
			var r = sqr[i], g = sqr[i+1], b = sqr[i+2];
			for(var j=i+4; j<64; j+=4) {
				var dst = dist(r,g,b, sqr[j],sqr[j+1],sqr[j+2]);
				if(dst>dd) {  dd=dst;  ends=(i<<8)|j;  }
			}
		}
		return ends;
	}
	UTEX.U = {
		_int8: new Uint8Array(4),
		readUintLE : function(buff, p)
		{
			UTEX.U._int8[0] = buff[p+0];
			UTEX.U._int8[1] = buff[p+1];
			UTEX.U._int8[2] = buff[p+2];
			UTEX.U._int8[3] = buff[p+3];
			return UTEX.U._int[0];
		},
		writeUintLE : function(buff, p, n)
		{
			UTEX.U._int[0] = n;
			buff[p+0] = UTEX.U._int8[0];
			buff[p+1] = UTEX.U._int8[1];
			buff[p+2] = UTEX.U._int8[2];
			buff[p+3] = UTEX.U._int8[3];
		},
		readASCII : function(buff, p, l)	// l : length in Characters (not Bytes)
		{
			var s = "";
			for(var i=0; i<l; i++) s += String.fromCharCode(buff[p+i]);
			return s;
		},
		writeASCII : function(buff, p, s)	// l : length in Characters (not Bytes)
		{
			for(var i = 0; i < s.length; i++)	
				buff[p+i] = s.charCodeAt(i);
		}
	}
	UTEX.U._int = new Uint32Array(UTEX.U._int8.buffer);
		
	if(UTEX==null) UTEX = {};
	
	UTEX.DDS = { 
		C : {
			DDSD_CAPS   : 0x1,  // always	// header flags
			DDSD_HEIGHT	: 0x2,  // always
			DDSD_WIDTH	: 0x4,  // always
			DDSD_PITCH  : 0x8,
			DDSD_PIXELFORMAT : 0x1000,	// always
			DDSD_MIPMAPCOUNT : 0x20000,
			DDSD_LINEARSIZE  : 0x80000,
			DDSD_DEPTH : 0x800000,
			
			DDPF_ALPHAPIXELS : 0x1,	// pixel format flags
			DDPF_ALPHA  : 0x2,
			DDPF_FOURCC : 0x4,
			DDPF_RGB    : 0x40,
			DDPF_YUV    : 0x200,
			DDPF_LUMINANCE : 0x20000,
			
			DDSCAPS_COMPLEX	: 0x8,
			DDSCAPS_MIPMAP  : 0x400000,
			DDSCAPS_TEXTURE : 0x1000
		},
	
		decode : function(buff)
		{
			var data = new Uint8Array(buff), offset = 0;
			var mgck = UTEX.U.readASCII(data, offset, 4);  offset+=4;
			
			var head, pf, hdr10, C = UTEX.DDS.C;
			
			head = UTEX.DDS.readHeader(data, offset);  offset += 124;
			pf = head.pixFormat;
			if( (pf.flags&C.DDPF_FOURCC) && pf.fourCC=="DX10") {  hdr10 = UTEX.DDS.readHeader10(data, offset);  offset+=20;  }
			//console.log(head, pf);
			
			var w = head.width, h = head.height, out = [];
			var fmt = pf.fourCC, bc  = pf.bitCount;
			
			//var time = Date.now();
			var mcnt = Math.max(1, head.mmcount);
			for(var it=0; it<mcnt; it++)
			{
				var img = new Uint8Array(w * h * 4);
				if(false) {}
				else if(fmt=="DXT1") offset=UTEX.readBC1(data, offset, img, w, h);
				else if(fmt=="DXT3") offset=UTEX.readBC2(data, offset, img, w, h);
				else if(fmt=="DXT5") offset=UTEX.readBC3(data, offset, img, w, h);
				else if(fmt=="DX10") offset=UTEX.readBC7(data, offset, img, w, h);
				else if(fmt=="ATC ") offset=UTEX.readATC(data, offset, img, w, h);
				else if(fmt=="ATCA") offset=UTEX.readATA(data, offset, img, w, h);
				else if(fmt=="ATCI") offset=UTEX.readATA(data, offset, img, w, h);
				else if((pf.flags&C.DDPF_ALPHAPIXELS) && (pf.flags&C.DDPF_RGB)) {
					if     (bc==32) {
						for(var i=0; i<img.length; i++) img[i] = data[offset+i];
						offset+=img.length;
					}
					else if(bc==16) {
						for(var i=0; i<img.length; i+=4) {
							var clr = (data[offset+(i>>1)+1]<<8) | data[offset+(i>>1)];
							img[i+0] = 255*(clr&pf.RMask)/pf.RMask;
							img[i+1] = 255*(clr&pf.GMask)/pf.GMask;
							img[i+2] = 255*(clr&pf.BMask)/pf.BMask;
							img[i+3] = 255*(clr&pf.AMask)/pf.AMask;
						}
						offset+=(img.length>>1);
					}
					else throw ("unknown bit count "+bc);
				}
				else if((pf.flags&C.DDPF_ALPHA) || (pf.flags&C.DDPF_ALPHAPIXELS) || (pf.flags&C.DDPF_LUMINANCE)) {
					if(bc==8)  {
						for(var i=0; i<img.length; i+=4) img[i+3] = data[offset+(i>>2)];
						offset+=(img.length>>2)
					}
					else throw "unknown bit count "+bc;
				}
				else {
					console.log("unknown texture format, head flags: ", head.flags.toString(2), "pixelFormat flags: ", pf.flags.toString(2));
					throw "e";
				}
				out.push({width:w, height:h, image:img.buffer});
				w = (w>>1);  h = (h>>1);
			}
			//console.log(Date.now()-time);  throw "e";
			return out; //out.slice(0,1);
		},
	
		encode : function(img, w, h)
		{
			var img = new Uint8Array(img);
			var aAnd = 255;
			for(var i=3; i<img.length; i+=4) aAnd &= img[i];
			var gotAlpha = aAnd<250;
			
			var data = new Uint8Array(124+(w*h*2)), offset = 0;
			UTEX.U.writeASCII(data, offset, "DDS ");                offset+=  4;
			UTEX.DDS.writeHeader(data, w, h, gotAlpha, offset);  offset+=124;
			
			var mcnt = 0;
			while(w*h!=0) {
				if(gotAlpha) offset = UTEX.writeBC3(img, w, h, data, offset);
				else         offset = UTEX.writeBC1(img, w, h, data, offset);
				img = UTEX.mipmapB(img, w, h);
				w = (w>>1);  h = (h>>1);
				mcnt++;
			}
			data[28] = mcnt;
			
			return data.buffer.slice(0, offset);
		},
	
		readHeader : function(data, offset)
		{
			var hd = {}, rUi = UTEX.U.readUintLE;
			offset+=4;	// size = 124
			hd.flags    = rUi(data, offset);  offset+=4;
			hd.height   = rUi(data, offset);  offset+=4;
			hd.width    = rUi(data, offset);  offset+=4;
			hd.pitch    = rUi(data, offset);  offset+=4;
			hd.depth    = rUi(data, offset);  offset+=4;
			hd.mmcount  = rUi(data, offset);  offset+=4;
			offset+=11*4;	// reserved, zeros
			hd.pixFormat= UTEX.DDS.readPixFormat(data, offset);  offset+=32;
			hd.caps     = rUi(data, offset);  offset+=4;
			hd.caps2    = rUi(data, offset);  offset+=4;
			hd.caps3    = rUi(data, offset);  offset+=4;
			hd.caps4    = rUi(data, offset);  offset+=4;
			offset+=4;  // reserved, zeros
			return hd;
		},
		writeHeader : function(data, w,h, gotAlpha, offset)
		{
			var wUi = UTEX.U.writeUintLE, C = UTEX.DDS.C;
			var flgs = C.DDSD_CAPS | C.DDSD_HEIGHT | C.DDSD_WIDTH | C.DDSD_PIXELFORMAT;
			flgs |= C.DDSD_MIPMAPCOUNT | C.DDSD_LINEARSIZE;
			
			var caps = C.DDSCAPS_COMPLEX | C.DDSCAPS_MIPMAP | C.DDSCAPS_TEXTURE;
			var pitch = ((w*h)>>1)*(gotAlpha?2:1), depth = gotAlpha ? 1 : 0;
			
			wUi(data, offset,    124);  offset+=4;
			wUi(data, offset,   flgs);  offset+=4;  // flags
			wUi(data, offset,      h);  offset+=4;
			wUi(data, offset,      w);  offset+=4;
			wUi(data, offset,  pitch);  offset+=4;
			wUi(data, offset,  depth);  offset+=4;
			wUi(data, offset,     10);  offset+=4;
			offset+=11*4;
			UTEX.DDS.writePixFormat(data, gotAlpha, offset);  offset+=32;
			wUi(data, offset,   caps);  offset+=4;  // caps
			offset += 4*4;
		},
	
		readPixFormat : function(data, offset) 
		{
			var pf = {}, rUi = UTEX.U.readUintLE;
			offset+=4;  // size = 32
			pf.flags    = rUi(data, offset);  offset+=4;
			pf.fourCC   = UTEX.U.readASCII(data, offset,4);  offset+=4;
			pf.bitCount = rUi(data, offset);  offset+=4;
			pf.RMask    = rUi(data, offset);  offset+=4;
			pf.GMask    = rUi(data, offset);  offset+=4;
			pf.BMask    = rUi(data, offset);  offset+=4;
			pf.AMask    = rUi(data, offset);  offset+=4;
			return pf;
		},
		writePixFormat : function(data, gotAlpha, offset)
		{
			var wUi = UTEX.U.writeUintLE, C = UTEX.DDS.C;
			var flgs = C.DDPF_FOURCC;
			
			wUi(data, offset,   32); offset+=4;
			wUi(data, offset, flgs); offset+=4;
			UTEX.U.writeASCII(data, offset, gotAlpha?"DXT5":"DXT1");  offset+=4;
			offset+=5*4;
		},
	
		readHeader10 : function(data, offset)
		{
			var hd = {}, rUi = UTEX.U.readUintLE;
			
			hd.format   = rUi(data, offset);  offset+=4;
			hd.dimension= rUi(data, offset);  offset+=4;
			hd.miscFlags= rUi(data, offset);  offset+=4;
			hd.arraySize= rUi(data, offset);  offset+=4;
			hd.miscFlags2=rUi(data, offset);  offset+=4;
			
			return hd;
		}
	}
	
	UTEX.PVR = {
		decode : function(buff)
		{
			var data = new Uint8Array(buff), offset = 0;
			var head = UTEX.PVR.readHeader(data, offset);  offset+=52;
			//var ooff = offset;
			//console.log(PUtils.readByteArray(data, offset, 10))
			offset += head.mdsize;
			
			console.log(head);
			
			var w = head.width, h = head.height;
			var img = new Uint8Array(h*w*4);
			
			var pf = head.pf0;
			if(pf==0) {
				for(var y=0; y<h; y++)
					for(var x=0; x<w; x++)
					{
						var i = y*w+x, qi = i<<2, bi = i<<1;
						
						//img[qi+0]=((data[offset+(bi>>3)]>>(bi&7))&3)*85;
						img[qi+3]=255;
					}
			}
			else console.log("Unknown pixel format: "+pf);
			
			return [{width:w, height:h, image:img.buffer}]
		},
		readHeader : function(data, offset)
		{
			var hd = {}, rUi = UTEX.U.readUintLE;
			hd.version  = rUi(data, offset);  offset+=4;
			hd.flags    = rUi(data, offset);  offset+=4;
			hd.pf0      = rUi(data, offset);  offset+=4;
			hd.pf1      = rUi(data, offset);  offset+=4;
			hd.cspace   = rUi(data, offset);  offset+=4;
			hd.ctype    = rUi(data, offset);  offset+=4;
			hd.height   = rUi(data, offset);  offset+=4;
			hd.width    = rUi(data, offset);  offset+=4;
			hd.sfnum     = rUi(data, offset);  offset+=4;
			hd.fcnum     = rUi(data, offset);  offset+=4;
			hd.mmcount  = rUi(data, offset);  offset+=4;
			hd.mdsize   = rUi(data, offset);  offset+=4;
			return hd;
		}
	}
;(function(){
var UTIF = {};

// Make available for import by `require()`
if (typeof module == "object") {module.exports = UTIF;}
else {self.UTIF = UTIF;}

var pako, JpegDecoder;
if (typeof require == "function") {pako = require("pako"); JpegDecoder = require("jpgjs").JpegDecoder;}
else {pako = self.pako; JpegDecoder = self.JpegDecoder;}

function log() { if (typeof process=="undefined" || process.env.NODE_ENV=="development") console.log.apply(console, arguments);  }

(function(UTIF, pako){

UTIF.encodeImage = function(rgba, w, h, metadata)
{
	var idf = { "t256":[w], "t257":[h], "t258":[8,8,8,8], "t259":[1], "t262":[2], "t273":[1000], // strips offset
				"t277":[4], "t278":[h], /* rows per strip */          "t279":[w*h*4], // strip byte counts
				"t282":[1], "t283":[1], "t284":[1], "t286":[0], "t287":[0], "t296":[1], "t305": ["Photopea (UTIF.js)"], "t338":[1]
		};
	if (metadata) {
		for (var i in metadata) {
			idf[i] = metadata[i];
		}
	}
	var prfx = new Uint8Array(UTIF.encode([idf]));
	var img = new Uint8Array(rgba);
	var data = new Uint8Array(1000+w*h*4);
	for(var i=0; i<prfx.length; i++) data[i] = prfx[i];
	for(var i=0; i<img .length; i++) data[1000+i] = img[i];
	return data.buffer;
}

UTIF.encode = function(ifds)
{
	var data = new Uint8Array(20000), offset = 4, bin = UTIF._binBE;
	data[0]=77;  data[1]=77;  data[3]=42;

	var ifdo = 8;
	bin.writeUint(data, offset, ifdo);  offset+=4;
	for(var i=0; i<ifds.length; i++)
	{
		var noffs = UTIF._writeIFD(bin, data, ifdo, ifds[i]);
		ifdo = noffs[1];
		if(i<ifds.length-1) bin.writeUint(data, noffs[0], ifdo);
	}
	return data.slice(0, ifdo).buffer;
}
//UTIF.encode._writeIFD

UTIF.decode = function(buff)
{
	UTIF.decode._decodeG3.allow2D = null;
	var data = new Uint8Array(buff), offset = 0;

	var id = UTIF._binBE.readASCII(data, offset, 2);  offset+=2;
	var bin = id=="II" ? UTIF._binLE : UTIF._binBE;
	var num = bin.readUshort(data, offset);  offset+=2;

	var ifdo = bin.readUint(data, offset);  offset+=4;
	var ifds = [];
	while(true)
	{
		var noff = UTIF._readIFD(bin, data, ifdo, ifds);
		//var ifd = ifds[ifds.length-1];   if(ifd["t34665"]) {  ifd.exifIFD = [];  UTIF._readIFD(bin, data, ifd["t34665"][0], ifd.exifIFD);  }
		ifdo = bin.readUint(data, noff);
		if(ifdo==0) break;
	}
	return ifds;
}


UTIF.decodeImages = function(buff, ifds)
{
	var data = new Uint8Array(buff);
	var id = UTIF._binBE.readASCII(data, 0, 2);
	
	for(var ii=0; ii<ifds.length; ii++)
	{
		var img = ifds[ii];
		if(img["t256"]==null) continue;	// EXIF files don't have TIFF tags
		img.isLE = id=="II";
		img.width  = img["t256"][0];  //delete img["t256"];
		img.height = img["t257"][0];  //delete img["t257"];

		var cmpr   = img["t259"][0];  //delete img["t259"];
		var fo = img["t266"] ? img["t266"][0] : 1;  //delete img["t266"];
		if(img["t284"] && img["t284"][0]==2) log("PlanarConriguration 2 should not be used!");

		var bipp = (img["t258"]?Math.min(32,img["t258"][0]):1) * (img["t277"]?img["t277"][0]:1);  // bits per pixel
		var soff = img["t273"];  if(soff==null) soff = img["t324"];
		var bcnt = img["t279"];  if(cmpr==1 && soff.length==1) bcnt = [Math.ceil(img.height*img.width*bipp/8)|0];  if(bcnt==null) bcnt = img["t325"];
		var bytes = new Uint8Array(Math.ceil(img.width*img.height*bipp/8)|0), bilen = 0;

		if(img["t322"]!=null) // tiled
		{
			var tw = img["t322"][0], th = img["t323"][0];
			var tx = Math.floor((img.width  + tw - 1) / tw);
			var ty = Math.floor((img.height + th - 1) / th);
			var tbuff = new Uint8Array(Math.ceil(tw*th*bipp/8)|0);
			for(var y=0; y<ty; y++)
				for(var x=0; x<tx; x++)
				{
					var i = y*tx+x;  for(var j=0; j<tbuff.length; j++) tbuff[j]=0;
					UTIF.decode._decompress(img, data, soff[i], bcnt[i], cmpr, tbuff, 0, fo);
					UTIF._copyTile(tbuff, Math.ceil(tw*bipp/8)|0, th, bytes, Math.ceil(img.width*bipp/8)|0, img.height, Math.ceil(x*tw*bipp/8)|0, y*th);
				}
			bilen = bytes.length*8;
		}
		else	// stripped
		{
			var rps = img["t278"] ? img["t278"][0] : img.height;   rps = Math.min(rps, img.height);
			for(var i=0; i<soff.length; i++)
			{
				UTIF.decode._decompress(img, data, soff[i], bcnt[i], cmpr, bytes, Math.ceil(bilen/8)|0, fo);
				bilen += (img.width * bipp * rps);
			}
			bilen = Math.min(bilen, bytes.length*8);
		}
		img.data = new Uint8Array(bytes.buffer, 0, Math.ceil(bilen/8)|0);
	}
}

UTIF.decode._decompress = function(img, data, off, len, cmpr, tgt, toff, fo)  // fill order
{
	if(false) {}
	else if(cmpr==1) for(var j=0; j<len; j++) tgt[toff+j] = data[off+j];
	else if(cmpr==3) UTIF.decode._decodeG3 (data, off, len, tgt, toff, img.width, fo);
	else if(cmpr==4) UTIF.decode._decodeG4 (data, off, len, tgt, toff, img.width, fo);
	else if(cmpr==5) UTIF.decode._decodeLZW(data, off, tgt, toff);
	else if(cmpr==7) UTIF.decode._decodeNewJPEG(img, data, off, len, tgt, toff);
	else if(cmpr==8) {  var src = new Uint8Array(data.buffer,off,len);  var bin = pako["inflate"](src);  for(var i=0; i<bin.length; i++) tgt[toff+i]=bin[i];  }
	else if(cmpr==32773) UTIF.decode._decodePackBits(data, off, len, tgt, toff);
	else if(cmpr==32809) UTIF.decode._decodeThunder (data, off, len, tgt, toff);
	//else if(cmpr==34713) UTIF.decode._decodeNikon   (data, off, len, tgt, toff);
	else log("Unknown compression", cmpr);

	if(img["t317"] && img["t317"][0]==2)
	{
		var noc = (img["t277"]?img["t277"][0]:1), h = (img["t278"] ? img["t278"][0] : img.height), bpr = img.width*noc;
		//console.log(noc);
		for(var y=0; y<h; y++) {
			var ntoff = toff+y*bpr;
			if(noc==3) for(var j=  3; j<bpr; j+=3) {
				tgt[ntoff+j  ] = (tgt[ntoff+j  ] + tgt[ntoff+j-3])&255;
				tgt[ntoff+j+1] = (tgt[ntoff+j+1] + tgt[ntoff+j-2])&255;
				tgt[ntoff+j+2] = (tgt[ntoff+j+2] + tgt[ntoff+j-1])&255;
			}
			else       for(var j=noc; j<bpr; j++) tgt[ntoff+j] = (tgt[ntoff+j] + tgt[ntoff+j-noc])&255;
		}
	}
}

UTIF.decode._decodeNikon = function(data, off, len, tgt, toff)
{
	var nikon_tree = [
    [ 0,1,5,1,1,1,1,1,1,2,0,0,0,0,0,0,	/* 12-bit lossy */
      5,4,3,6,2,7,1,0,8,9,11,10,12 ],
    [ 0,1,5,1,1,1,1,1,1,2,0,0,0,0,0,0,	/* 12-bit lossy after split */
      0x39,0x5a,0x38,0x27,0x16,5,4,3,2,1,0,11,12,12 ],
    [ 0,1,4,2,3,1,2,0,0,0,0,0,0,0,0,0,  /* 12-bit lossless */
      5,4,6,3,7,2,8,1,9,0,10,11,12 ],
    [ 0,1,4,3,1,1,1,1,1,2,0,0,0,0,0,0,	/* 14-bit lossy */
      5,6,4,7,8,3,9,2,1,0,10,11,12,13,14 ],
    [ 0,1,5,1,1,1,1,1,1,1,2,0,0,0,0,0,	/* 14-bit lossy after split */
      8,0x5c,0x4b,0x3a,0x29,7,6,5,4,3,2,1,0,13,14 ],
    [ 0,1,4,2,2,3,1,2,0,0,0,0,0,0,0,0,	/* 14-bit lossless */
      7,6,8,5,9,4,10,3,11,12,2,0,1,13,14 ] ];
	  
	//struct decode *dindex;
	var ver0, ver1, vpred, hpred, csize;
	var i, min, max, step=0, huff=0, split=0, row, col, len, shl, diff;
	
	console.log(data.slice(off,off+100));
	ver0 = data[off];  off++;
	ver1 = data[off];  off++;
	console.log(ver0.toString(16), ver1.toString(16), len);
}

UTIF.decode._decodeNewJPEG = function(img, data, off, len, tgt, toff)
{
	//throw "e";
	//console.log("_decodeNewJPEG", off, toff);
    if (typeof JpegDecoder=="undefined") { log("jpg.js required for handling JPEG compressed images");  return;  }

    var tables = img["t347"], tlen = tables ? tables.length : 0, buff = new Uint8Array(tlen + len);

    if (tables) {
		var SOI = 216, EOI = 217, boff = 0;
        for (var i=0; i<(tlen-1); i++) {
            // Skip EOI marker from JPEGTables
            if (tables[i]==255 && tables[i+1]==EOI) break;
            buff[boff++] = tables[i];
        }

        // Skip SOI marker from data
        var byte1 = data[off], byte2 = data[off + 1];
        if (byte1!=255 || byte2!=SOI) {
            buff[boff++] = byte1;
            buff[boff++] = byte2;
        }
        for (var i=2; i<len; i++) buff[boff++] = data[off+i];
    }
	else
        for (var i=0; i<len; i++) buff[i] = data[off+i];

	if(img["t262"]==32803) {	// lossless JPEG (used in DNG files) is not available in JpegDecoder. 
		var bps = img["t258"][0], dcdr = new LosslessJpegDecoder();
		var out = dcdr.decode(buff), olen=out.length;
		
		if(false) {}
		else if(bps==16) for(var i=0; i<olen; i++) {  tgt[toff++] = (out[i]&255);  tgt[toff++] = (out[i]>>>8);  }
		else if(bps==12) {
			for(var i=0; i<olen; i+=2) {  tgt[toff++] = (out[i]>>>4);  tgt[toff++] = ((out[i]<<4)|(out[i+1]>>>8))&255;  tgt[toff++] = out[i+1]&255;  }
		}
		else throw "unsupported bit depth "+bps;
	}
	else {
		var parser = new JpegDecoder();  parser.parse(buff);
		var decoded = parser.getData(parser.width, parser.height);
		for (var i=0; i<decoded.length; i++) tgt[toff + i] = decoded[i];
	}
	
	//console.log(out);
	//throw "e";
	
	//throw "e";

    // PhotometricInterpretation is 6 (YCbCr) for JPEG, but after decoding we populate data in
    // RGB format, so updating the tag value
    if(img["t262"][0] == 6)  img["t262"][0] = 2;
}

UTIF.decode._decodePackBits = function(data, off, len, tgt, toff)
{
	var sa = new Int8Array(data.buffer), ta = new Int8Array(tgt.buffer), lim = off+len;
	while(off<lim) {
		var n = sa[off];  off++;
		if(n>=0  && n<128)    for(var i=0; i< n+1; i++) {  ta[toff]=sa[off];  toff++;  off++;   }
		if(n>=-127 && n<0) {  for(var i=0; i<-n+1; i++) {  ta[toff]=sa[off];  toff++;           }  off++;  }
	}
}
UTIF.decode._decodeThunder = function(data, off, len, tgt, toff)
{
	var d2 = [ 0, 1, 0, -1 ],  d3 = [ 0, 1, 2, 3, 0, -3, -2, -1 ];
	var lim = off+len, qoff = toff*2, px = 0;
	while(off<lim) {
		var b = data[off], msk = (b>>>6), n = (b&63);  off++;
		if(msk==3) { px=(n&15);  tgt[qoff>>>1] |= (px<<(4*(1-qoff&1)));  qoff++;   }
		if(msk==0) for(var i=0; i<n; i++) {  tgt[qoff>>>1] |= (px<<(4*(1-qoff&1)));  qoff++;   }
		if(msk==2) for(var i=0; i<2; i++) {  var d=(n>>>(3*(1-i)))&7;  if(d!=4) { px+=d3[d];  tgt[qoff>>>1] |= (px<<(4*(1-qoff&1)));  qoff++; }  }
		if(msk==1) for(var i=0; i<3; i++) {  var d=(n>>>(2*(2-i)))&3;  if(d!=2) { px+=d2[d];  tgt[qoff>>>1] |= (px<<(4*(1-qoff&1)));  qoff++; }  }
	}
}

UTIF.decode._dmap = { "1":0,"011":1,"000011":2,"0000011":3, "010":-1,"000010":-2,"0000010":-3  };
UTIF.decode._lens = ( function() {
	var addKeys = function(lens, arr, i0, inc) {  for(var i=0; i<arr.length; i++) lens[arr[i]] = i0 + i*inc;  }

	var termW = "00110101,000111,0111,1000,1011,1100,1110,1111,10011,10100,00111,01000,001000,000011,110100,110101," // 15
	+ "101010,101011,0100111,0001100,0001000,0010111,0000011,0000100,0101000,0101011,0010011,0100100,0011000,00000010,00000011,00011010," // 31
	+ "00011011,00010010,00010011,00010100,00010101,00010110,00010111,00101000,00101001,00101010,00101011,00101100,00101101,00000100,00000101,00001010," // 47
	+ "00001011,01010010,01010011,01010100,01010101,00100100,00100101,01011000,01011001,01011010,01011011,01001010,01001011,00110010,00110011,00110100";

	var termB = "0000110111,010,11,10,011,0011,0010,00011,000101,000100,0000100,0000101,0000111,00000100,00000111,000011000," // 15
	+ "0000010111,0000011000,0000001000,00001100111,00001101000,00001101100,00000110111,00000101000,00000010111,00000011000,000011001010,000011001011,000011001100,000011001101,000001101000,000001101001," // 31
	+ "000001101010,000001101011,000011010010,000011010011,000011010100,000011010101,000011010110,000011010111,000001101100,000001101101,000011011010,000011011011,000001010100,000001010101,000001010110,000001010111," // 47
	+ "000001100100,000001100101,000001010010,000001010011,000000100100,000000110111,000000111000,000000100111,000000101000,000001011000,000001011001,000000101011,000000101100,000001011010,000001100110,000001100111";

	var makeW = "11011,10010,010111,0110111,00110110,00110111,01100100,01100101,01101000,01100111,011001100,011001101,011010010,011010011,011010100,011010101,011010110,"
	+ "011010111,011011000,011011001,011011010,011011011,010011000,010011001,010011010,011000,010011011";

	var makeB = "0000001111,000011001000,000011001001,000001011011,000000110011,000000110100,000000110101,0000001101100,0000001101101,0000001001010,0000001001011,0000001001100,"
	+ "0000001001101,0000001110010,0000001110011,0000001110100,0000001110101,0000001110110,0000001110111,0000001010010,0000001010011,0000001010100,0000001010101,0000001011010,"
	+ "0000001011011,0000001100100,0000001100101";

	var makeA = "00000001000,00000001100,00000001101,000000010010,000000010011,000000010100,000000010101,000000010110,000000010111,000000011100,000000011101,000000011110,000000011111";

	termW = termW.split(",");  termB = termB.split(",");  makeW = makeW.split(",");  makeB = makeB.split(",");  makeA = makeA.split(",");

	var lensW = {}, lensB = {};
	addKeys(lensW, termW, 0, 1);  addKeys(lensW, makeW, 64,64);  addKeys(lensW, makeA, 1792,64);
	addKeys(lensB, termB, 0, 1);  addKeys(lensB, makeB, 64,64);  addKeys(lensB, makeA, 1792,64);
	return [lensW, lensB];    } )();

UTIF.decode._decodeG4 = function(data, off, slen, tgt, toff, w, fo)
{
	var U = UTIF.decode, boff=off<<3, len=0, wrd="";	// previous starts with 1
	var line=[], pline=[];  for(var i=0; i<w; i++) pline.push(0);  pline=U._makeDiff(pline);
	var a0=0, a1=0, a2=0, b1=0, b2=0, clr=0;
	var y=0, mode="", toRead=0;

	while((boff>>>3)<off+slen)
	{
		b1 = U._findDiff(pline, a0+(a0==0?0:1), 1-clr), b2 = U._findDiff(pline, b1, clr);	// could be precomputed
		var bit =0;
		if(fo==1) bit = (data[boff>>>3]>>>(7-(boff&7)))&1;
		if(fo==2) bit = (data[boff>>>3]>>>(  (boff&7)))&1;
		boff++;  wrd+=bit;
		if(mode=="H") {
			if(U._lens[clr][wrd]!=null) {
				var dl=U._lens[clr][wrd];  wrd="";  len+=dl;
				if(dl<64) {  U._addNtimes(line,len,clr);  a0+=len;  clr=1-clr;  len=0;  toRead--;  if(toRead==0) mode="";  }
			}
		}
		else {
			if(wrd=="0001")  {  wrd="";  U._addNtimes(line,b2-a0,clr);  a0=b2;   }
			if(wrd=="001" )  {  wrd="";  mode="H";  toRead=2;  }
			if(U._dmap[wrd]!=null) {  a1 = b1+U._dmap[wrd];  U._addNtimes(line, a1-a0, clr);  a0=a1;  wrd="";  clr=1-clr;  }
		}
		if(line.length==w && mode=="") {
			U._writeBits(line, tgt, toff*8+y*w);
			clr=0;  y++;  a0=0;
			pline=U._makeDiff(line);  line=[];
		}
		//if(wrd.length>150) {  log(wrd);  break;  throw "e";  }
	}
}

UTIF.decode._findDiff = function(line, x, clr) {  for(var i=0; i<line.length; i+=2) if(line[i]>=x && line[i+1]==clr)  return line[i];  }
UTIF.decode._makeDiff = function(line) {
	var out = [];  if(line[0]==1) out.push(0,1);
	for(var i=1; i<line.length; i++) if(line[i-1]!=line[i]) out.push(i, line[i]);
	out.push(line.length,0,line.length,1);  return out;
}
UTIF.decode._decodeG3 = function(data, off, slen, tgt, toff, w, fo)
{
	var U = UTIF.decode, boff=off<<3, len=0, wrd="";
	var line=[], pline=[];  for(var i=0; i<w; i++) line.push(0);
	var a0=0, a1=0, a2=0, b1=0, b2=0, clr=0;
	var y=-1, mode="", toRead=0, is1D=false;
	while((boff>>>3)<off+slen)
	{
		b1 = U._findDiff(pline, a0+(a0==0?0:1), 1-clr), b2 = U._findDiff(pline, b1, clr);	// could be precomputed
		var bit =0;
		if(fo==1) bit = (data[boff>>>3]>>>(7-(boff&7)))&1;
		if(fo==2) bit = (data[boff>>>3]>>>(  (boff&7)))&1;
		boff++;  wrd+=bit;

		if(is1D) {
			if(U._lens[clr][wrd]!=null) {
				var dl=U._lens[clr][wrd];  wrd="";  len+=dl;
				if(dl<64) {  U._addNtimes(line,len,clr);  clr=1-clr;  len=0;  }
			}
		}
		else  {
			if(mode=="H") {
				if(U._lens[clr][wrd]!=null) {
					var dl=U._lens[clr][wrd];  wrd="";  len+=dl;
					if(dl<64) {  U._addNtimes(line,len,clr);  a0+=len;  clr=1-clr;  len=0;  toRead--;  if(toRead==0) mode="";  }
				}
			}
			else {
				if(wrd=="0001")  {  wrd="";  U._addNtimes(line,b2-a0,clr);  a0=b2;   }
				if(wrd=="001" )  {  wrd="";  mode="H";  toRead=2;  }
				if(U._dmap[wrd]!=null) {  a1 = b1+U._dmap[wrd];  U._addNtimes(line, a1-a0, clr);  a0=a1;  wrd="";  clr=1-clr;  }
			}
		}
		if(wrd.endsWith("000000000001")) { 	// needed for some files
			if(y>=0) U._writeBits(line, tgt, toff*8+y*w);
			if(fo==1) is1D = ((data[boff>>>3]>>>(7-(boff&7)))&1)==1;
			if(fo==2) is1D = ((data[boff>>>3]>>>(  (boff&7)))&1)==1;
			boff++;
			if(U._decodeG3.allow2D==null) U._decodeG3.allow2D=is1D;
			if(!U._decodeG3.allow2D) {  is1D = true;  boff--;  }
			//log("EOL",y, "next 1D:", is1D);
			wrd="";  clr=0;  y++;  a0=0;
			pline=U._makeDiff(line);  line=[];
		}
	}
	if(line.length==w) U._writeBits(line, tgt, toff*8+y*w);
}

UTIF.decode._addNtimes = function(arr, n, val) {  for(var i=0; i<n; i++) arr.push(val);  }

UTIF.decode._writeBits = function(bits, tgt, boff)
{
	for(var i=0; i<bits.length; i++) tgt[(boff+i)>>>3] |= (bits[i]<<(7-((boff+i)&7)));
}

UTIF.decode._decodeLZW = function(data, off, tgt, toff)
{
	if(UTIF.decode._lzwTab==null) {
		var tb=new Uint32Array(0xffff), tn=new Uint16Array(0xffff), chr=new Uint8Array(2e6);  
		for(var i=0; i<256; i++) { chr[i<<2]=i;  tb[i]=i<<2;  tn[i]=1;  }
		UTIF.decode._lzwTab = [tb,tn,chr];
	}
	var copy = UTIF.decode._copyData;
	var tab = UTIF.decode._lzwTab[0], tln=UTIF.decode._lzwTab[1], chr=UTIF.decode._lzwTab[2], totl = 258, chrl = 258<<2;
	var bits = 9, boff = off<<3;  // offset in bits

	var ClearCode = 256, EoiCode = 257;
	var v = 0, Code = 0, OldCode = 0;
	while(true) {
		v = (data[boff>>>3]<<16) | (data[(boff+8)>>>3]<<8) | data[(boff+16)>>>3];
		Code = ( v>>(24-(boff&7)-bits) )    &   ((1<<bits)-1);  boff+=bits;
		
		if(Code==EoiCode) break;
		if(Code==ClearCode) {
			bits=9;  totl = 258;  chrl = 258<<2;
			
			v = (data[boff>>>3]<<16) | (data[(boff+8)>>>3]<<8) | data[(boff+16)>>>3];
			Code = ( v>>(24-(boff&7)-bits) )    &   ((1<<bits)-1);  boff+=bits;
			if(Code==EoiCode) break;
			tgt[toff]=Code;  toff++;
		}
		else if(Code<totl) {
			var cd = tab[Code], cl = tln[Code];
			copy(chr,cd,tgt,toff,cl);  toff += cl;

			if(OldCode>=totl) {  tab[totl] = chrl;  chr[tab[totl]] = cd[0];  tln[totl]=1;  chrl=(chrl+1+3)&~0x03;  totl++;  }
			else {
				tab[totl] = chrl;
				var nit = tab[OldCode], nil = tln[OldCode];
				copy(chr,nit,chr,chrl,nil);
				chr[chrl+nil]=chr[cd];  nil++;
				tln[totl]=nil;  totl++;
				
				chrl=(chrl+nil+3)&~0x03;
			}
			if(totl+1==(1<<bits)) bits++;
		}
		else {
			if(OldCode>=totl) {  tab[totl] = chrl;  tln[totl]=0;  totl++;  }
			else {
				tab[totl] = chrl;
				var nit = tab[OldCode], nil = tln[OldCode];
				copy(chr,nit,chr,chrl,nil);
				chr[chrl+nil]=chr[chrl];  nil++;
				tln[totl]=nil;  totl++;
				
				copy(chr,chrl,tgt,toff,nil);  toff += nil;  
				chrl=(chrl+nil+3)&~0x03;
			}
			if(totl+1==(1<<bits)) bits++;
		}
		OldCode = Code;
	}
}
UTIF.decode._copyData = function(s,so,t,to,l) {  for(var i=0;i<l;i+=4) {  t[to+i]=s[so+i];  t[to+i+1]=s[so+i+1];  t[to+i+2]=s[so+i+2];  t[to+i+3]=s[so+i+3];  }  }

UTIF.tags = {254:"NewSubfileType",255:"SubfileType",256:"ImageWidth",257:"ImageLength",258:"BitsPerSample",259:"Compression",262:"PhotometricInterpretation",266:"FillOrder",
			 269:"DocumentName",270:"ImageDescription",271:"Make",272:"Model",273:"StripOffset",274:"Orientation",277:"SamplesPerPixel",278:"RowsPerStrip",
			 279:"StripByteCounts",280:"MinSampleValue",281:"MaxSampleValue",282:"XResolution",283:"YResolution",284:"PlanarConfiguration",285:"PageName",
			 286:"XPosition",287:"YPosition",
			 292:"T4Options",296:"ResolutionUnit",297:"PageNumber",305:"Software",306:"DateTime",315:"Artist",316:"HostComputer",317:"Predictor",320:"ColorMap",
			 321:"HalftoneHints",322:"TileWidth",
			 323:"TileLength",324:"TileOffset",325:"TileByteCounts",330:"SubIFDs",336:"DotRange",338:"ExtraSample",339:"SampleFormat", 347:"JPEGTables",
			 512:"JPEGProc",513:"JPEGInterchangeFormat",514:"JPEGInterchangeFormatLength",519:"JPEGQTables",520:"JPEGDCTables",521:"JPEGACTables",
			 529:"YCbCrCoefficients",530:"YCbCrSubSampling",531:"YCbCrPositioning",532:"ReferenceBlackWhite",700:"XMP",
			 33421:"CFARepeatPatternDim",33422:"CFAPattern",33432:"Copyright",33434:"ExposureTime",33437:"FNumber",33723:"IPTC/NAA",34377:"Photoshop",
			 34665:"ExifIFD",34850:"ExposureProgram",34853:"GPSInfo",34855:"ISOSpeedRatings",34858:"TimeZoneOffset",34859:"SelfTimeMode",
			 36867:"DateTimeOriginal",36868:"DateTimeDigitized",
			 37377:"ShutterSpeedValue",37378:"ApertureValue",37380:"ExposureBiasValue",37383:"MeteringMode",37385:"Flash",37386:"FocalLength",
			 37390:"FocalPlaneXResolution",37391:"FocalPlaneYResolution",37392:"FocalPlaneResolutionUnit",37393:"ImageNumber",37398:"TIFF/EPStandardID",37399:"SensingMethod",
			 37500:"MakerNote",37510:"UserComment",
			 40092:"XPComment",40094:"XPKeywords",
			 40961:"ColorSpace",40962:"PixelXDimension",40963:"PixelXDimension",41486:"FocalPlaneXResolution",41487:"FocalPlaneYResolution",41488:"FocalPlaneResolutionUnit",
			 41985:"CustomRendered",41986:"ExposureMode",41987:"WhiteBalance",41990:"SceneCaptureType",
			 50706:"DNGVersion",50707:"DNGBackwardVersion",50708:"UniqueCameraModel",50709:"LocalizedCameraModel",50710:"CFAPlaneColor",
			 50711:"CFALayout",50712:"LinearizationTable",50713:"BlackLevelRepeatDim",50714:"BlackLevel",50716:"BlackLevelDeltaV",50717:"WhiteLevel",
			 50718:"DefaultScale",50719:"DefaultCropOrigin",
			 50720:"DefaultCropSize",50733:"BayerGreenSplit",50738:"AntiAliasStrength",
			 50721:"ColorMatrix1",50722:"ColorMatrix2",50723:"CameraCalibration1",50724:"CameraCalibration2",50727:"AnalogBalance",50728:"AsShotNeutral",
			 50730:"BaselineExposure",50731:"BaselineNoise",50732:"BaselineSharpness",50734:"LinearResponseLimit",50735:"CameraSerialNumber",50736:"LensInfo",50739:"ShadowScale",
			 50740:"DNGPrivateData",50741:"MakerNoteSafety",50778:"CalibrationIlluminant1",50779:"CalibrationIlluminant2",50780:"BestQualityScale",
			 50781:"RawDataUniqueID",50827:"OriginalRawFileName",50829:"ActiveArea",50830:"MaskedAreas",50931:"CameraCalibrationSignature",50932:"ProfileCalibrationSignature",
			 50935:"NoiseReductionApplied",50936:"ProfileName",50937:"ProfileHueSatMapDims",50938:"ProfileHueSatMapData1",50939:"ProfileHueSatMapData2",
			 50940:"ProfileToneCurve",50941:"ProfileEmbedPolicy",50942:"ProfileCopyright",
			 50964:"ForwardMatrix1",50965:"ForwardMatrix2",50966:"PreviewApplicationName",50967:"PreviewApplicationVersion",50969:"PreviewSettingsDigest",
			 50970:"PreviewColorSpace",50971:"PreviewDateTime",50972:"RawImageDigest",
			 51008:"OpcodeList1",51009:"OpcodeList2",51022:"OpcodeList3",51041:"NoiseProfile",51089:"OriginalDefaultFinalSize",
			 51090:"OriginalBestQualityFinalSize",51091:"OriginalDefaultCropSize",51125:"DefaultUserCrop"};

UTIF.ttypes = {  256:3,257:3,258:3,   259:3, 262:3,  273:4,  274:3, 277:3,278:4,279:4, 282:5, 283:5, 284:3, 286:5,287:5, 296:3, 305:2, 306:2, 338:3, 513:4, 514:4, 34665:4  };

UTIF._readIFD = function(bin, data, offset, ifds)
{
	var cnt = bin.readUshort(data, offset);  offset+=2;
	var ifd = {};  ifds.push(ifd);

	//console.log(">>>----------------");
	for(var i=0; i<cnt; i++) {
		var tag  = bin.readUshort(data, offset);    offset+=2;
		var type = bin.readUshort(data, offset);    offset+=2;
		var num  = bin.readUint  (data, offset);    offset+=4;
		var voff = bin.readUint  (data, offset);    offset+=4;

		var arr = [];
		ifd["t"+tag] = arr;
		//ifd["t"+tag+"-"+UTIF.tags[tag]] = arr;
		if(type== 1 || type==7) {  for(var j=0; j<num; j++) arr.push(data[(num<5 ? offset-4 : voff)+j]); }
		if(type== 2) {  arr.push( bin.readASCII(data, (num<5 ? offset-4 : voff), num-1) );  }
		if(type== 3) {  for(var j=0; j<num; j++) arr.push(bin.readUshort(data, (num<3 ? offset-4 : voff)+2*j));  }
		if(type== 4) {  for(var j=0; j<num; j++) arr.push(bin.readUint  (data, (num<2 ? offset-4 : voff)+4*j));  }
		if(type== 5) {  for(var j=0; j<num; j++) arr.push(bin.readUint  (data, voff+j*8) / bin.readUint(data,voff+j*8+4));  }
		if(type== 8) {  for(var j=0; j<num; j++) arr.push(bin.readShort (data, (num<3 ? offset-4 : voff)+2*j));  }
		if(type== 9) {  for(var j=0; j<num; j++) arr.push(bin.readInt   (data, (num<2 ? offset-4 : voff)+4*j));  }
		if(type==10) {  for(var j=0; j<num; j++) arr.push(bin.readInt   (data, voff+j*8) / bin.readInt (data,voff+j*8+4));  }
		if(type==11) {  for(var j=0; j<num; j++) arr.push(bin.readFloat (data, voff+j*4));  }
		if(type==12) {  for(var j=0; j<num; j++) arr.push(bin.readDouble(data, voff+j*8));  }
		if(num!=0 && arr.length==0) log("unknown TIFF tag type: ", type, "num:",num);
		//log(tag, type, UTIF.tags[tag], arr);
		if(tag==  330) for(var j=0; j<num; j++) UTIF._readIFD(bin, data, arr[j], ifds);
		//if(tag==34665) UTIF._readIFD(bin, data, arr[0], ifds);
	}
	//console.log("<<<---------------");
	return offset;
}
UTIF._writeIFD = function(bin, data, offset, ifd)
{
	var keys = Object.keys(ifd);
	bin.writeUshort(data, offset, keys.length);  offset+=2;

	var eoff = offset + keys.length*12 + 4;

	for(var ki=0; ki<keys.length; ki++) {
		var key = keys[ki];
		var tag = parseInt(key.slice(1)), type = UTIF.ttypes[tag];  if(type==null) throw "unknown type of tag: "+tag;
		var val = ifd[key];  if(type==2) val=val[0]+"\u0000";  var num = val.length;
		bin.writeUshort(data, offset, tag );  offset+=2;
		bin.writeUshort(data, offset, type);  offset+=2;
		bin.writeUint  (data, offset, num );  offset+=4;

		var dlen = [-1, 1, 1, 2, 4, 8, 0, 0, 0, 0, 0, 0, 8][type] * num;
		var toff = offset;
		if(dlen>4) {  bin.writeUint(data, offset, eoff);  toff=eoff;  }

		if(type==2) {  bin.writeASCII(data, toff, val);   }
		if(type==3) {  for(var i=0; i<num; i++) bin.writeUshort(data, toff+2*i, val[i]);    }
		if(type==4) {  for(var i=0; i<num; i++) bin.writeUint  (data, toff+4*i, val[i]);    }
		if(type==5) {  for(var i=0; i<num; i++) {  bin.writeUint(data, toff+8*i, Math.round(val[i]*10000));  bin.writeUint(data, toff+8*i+4, 10000);  }   }
		if (type == 12) {  for (var i = 0; i < num; i++) bin.writeDouble(data, toff + 8 * i, val[i]); }

		if(dlen>4) {  dlen += (dlen&1);  eoff += dlen;  }
		offset += 4;
	}
	return [offset, eoff];
}

UTIF.toRGBA8 = function(out)
{
	var w = out.width, h = out.height, area = w*h, qarea = area*4, data = out.data;
	var img = new Uint8Array(area*4);
	// 0: WhiteIsZero, 1: BlackIsZero, 2: RGB, 3: Palette color, 4: Transparency mask, 5: CMYK
	var intp = out["t262"][0], bps = (out["t258"]?Math.min(32,out["t258"][0]):1), isLE = out.isLE ? 1 : 0;
	//log("interpretation: ", intp, "bps", bps, out);
	if(false) {}
	else if(intp==0) {
		if(bps== 1) for(var i=0; i<area; i++) {  var qi=i<<2, px=((data[i>>3])>>(7-  (i&7)))& 1;  img[qi]=img[qi+1]=img[qi+2]=( 1-px)*255;  img[qi+3]=255;    }
		if(bps== 4) for(var i=0; i<area; i++) {  var qi=i<<2, px=((data[i>>1])>>(4-4*(i&1)))&15;  img[qi]=img[qi+1]=img[qi+2]=(15-px)* 17;  img[qi+3]=255;    }
		if(bps== 8) for(var i=0; i<area; i++) {  var qi=i<<2, px=data[i];  img[qi]=img[qi+1]=img[qi+2]=255-px;  img[qi+3]=255;    }
	}
	else if(intp==1) {
		if(bps== 1) for(var i=0; i<area; i++) {  var qi=i<<2, px=((data[i>>3])>>(7-  (i&7)))&1;   img[qi]=img[qi+1]=img[qi+2]=(px)*255;  img[qi+3]=255;    }
		if(bps== 2) for(var i=0; i<area; i++) {  var qi=i<<2, px=((data[i>>2])>>(6-2*(i&3)))&3;   img[qi]=img[qi+1]=img[qi+2]=(px)* 85;  img[qi+3]=255;    }
		if(bps== 8) for(var i=0; i<area; i++) {  var qi=i<<2, px=data[i];  img[qi]=img[qi+1]=img[qi+2]=    px;  img[qi+3]=255;    }
		if(bps==16) for(var i=0; i<area; i++) {  var qi=i<<2, px=data[2*i+isLE];  img[qi]=img[qi+1]=img[qi+2]= Math.min(255,px);  img[qi+3]=255;    } // ladoga.tif
	}
	else if(intp==2) {
		if(bps== 8) {	// this needs to be simplified ... how many channels are there???
			if(out["t338"]) {
				 if(out["t338"][0]>0) for(var i=0; i<qarea; i++) img[i] = data[i];	// sometimes t338 is 1 or 2 in case of Alpha
				 else  for(var i=0; i<qarea; i+=4) {  img[i] = data[i];  img[i+1] = data[i+1];  img[i+2] = data[i+2];  img[i+3] = 255;  }
			}
			else {
				var smpls = out["t258"]?out["t258"].length : 3;
				if(smpls==4) for(var i=0; i<qarea; i++) img[i] = data[i];
				if(smpls==3) for(var i=0; i< area; i++) {  var qi=i<<2, ti=i*3;  img[qi]=data[ti];  img[qi+1]=data[ti+1];  img[qi+2]=data[ti+2];  img[qi+3]=255;    }
			}
		}
		else  // 3x 16-bit channel
			for(var i=0; i<area; i++) {  var qi=i<<2, ti=i*6;  img[qi]=data[ti];  img[qi+1]=data[ti+2];  img[qi+2]=data[ti+4];  img[qi+3]=255;    }
	}
	else if(intp==3) {
		var map = out["t320"];
		for(var i=0; i<area; i++) {  var qi=i<<2, mi=data[i];  img[qi]=(map[mi]>>8);  img[qi+1]=(map[256+mi]>>8);  img[qi+2]=(map[512+mi]>>8);  img[qi+3]=255;    }
	}
	else if(intp==5) for(var i=0; i<area; i++) {
		var qi=i<<2;  var C=255-data[qi], M=255-data[qi+1], Y=255-data[qi+2], K=(255-data[qi+3])*(1/255);
		img[qi]=Math.round(C*K);  img[qi+1]=Math.round(M*K);  img[qi+2]=Math.round(Y*K);  img[qi+3]=255;
	}
	else log("Unknown Photometric interpretation: "+intp);
	return img;
}

UTIF.replaceIMG = function()
{
	var imgs = document.getElementsByTagName("img");
	for (var i=0; i<imgs.length; i++) {
		var img=imgs[i], src=img.getAttribute("src");  if(src==null) continue;
		var suff=src.split(".").pop().toLowerCase();
		if(suff!="tif" && suff!="tiff") continue;
		var xhr = new XMLHttpRequest();  UTIF._xhrs.push(xhr);  UTIF._imgs.push(img);
		xhr.open("GET", src);  xhr.responseType = "arraybuffer";
		xhr.onload = UTIF._imgLoaded;   xhr.send();
	}
}
UTIF._xhrs = [];  UTIF._imgs = [];
UTIF._imgLoaded = function(e)
{
	var buff = e.target.response;
	var ifds = UTIF.decode(buff), page = ifds[0];  UTIF.decodeImages(buff, ifds);
	var rgba = UTIF.toRGBA8(page), w=page.width, h=page.height;
	var ind = UTIF._xhrs.indexOf(e.target), img = UTIF._imgs[ind];
	UTIF._xhrs.splice(ind,1);  UTIF._imgs.splice(ind,1);
	var cnv = document.createElement("canvas");  cnv.width=w;  cnv.height=h;
	var ctx = cnv.getContext("2d"), imgd = ctx.createImageData(w,h);
	for(var i=0; i<rgba.length; i++) imgd.data[i]=rgba[i];       ctx.putImageData(imgd,0,0);
	var attr = ["style","class","id"];
	for(var i=0; i<attr.length; i++) cnv.setAttribute(attr[i], img.getAttribute(attr[i]));
	img.parentNode.replaceChild(cnv,img);
}


UTIF._binBE = {
	nextZero   : function(data, o) {  while(data[o]!=0) o++;  return o;  },
	readUshort : function(buff, p) {  return (buff[p]<< 8) |  buff[p+1];  },
	readShort  : function(buff, p) {  var a=UTIF._binBE.ui8;  a[0]=buff[p+1];  a[1]=buff[p+0];                                    return UTIF._binBE. i16[0];  },
	readInt    : function(buff, p) {  var a=UTIF._binBE.ui8;  a[0]=buff[p+3];  a[1]=buff[p+2];  a[2]=buff[p+1];  a[3]=buff[p+0];  return UTIF._binBE. i32[0];  },
	readUint   : function(buff, p) {  var a=UTIF._binBE.ui8;  a[0]=buff[p+3];  a[1]=buff[p+2];  a[2]=buff[p+1];  a[3]=buff[p+0];  return UTIF._binBE.ui32[0];  },
	readASCII  : function(buff, p, l) {  var s = "";   for(var i=0; i<l; i++) s += String.fromCharCode(buff[p+i]);   return s; },
	readFloat  : function(buff, p) {  var a=UTIF._binBE.ui8;  for(var i=0;i<4;i++) a[i]=buff[p+3-i];  return UTIF._binBE.fl32[0];  },
	readDouble : function(buff, p) {  var a=UTIF._binBE.ui8;  for(var i=0;i<8;i++) a[i]=buff[p+7-i];  return UTIF._binBE.fl64[0];  },

	writeUshort: function(buff, p, n) {  buff[p] = (n>> 8)&255;  buff[p+1] =  n&255;  },
	writeUint  : function(buff, p, n) {  buff[p] = (n>>24)&255;  buff[p+1] = (n>>16)&255;  buff[p+2] = (n>>8)&255;  buff[p+3] = (n>>0)&255;  },
	writeASCII : function(buff, p, s) {  for(var i = 0; i < s.length; i++)  buff[p+i] = s.charCodeAt(i);  },
	writeDouble: function(buff, p, n) {
		UTIF._binBE.fl64[0] = n;
		for (var i = 0; i < 8; i++) {
	  		buff[p + i] = UTIF._binBE.ui8[7 - i];
		}
	}
}
UTIF._binBE.ui8  = new Uint8Array  (8);
UTIF._binBE.i16  = new Int16Array  (UTIF._binBE.ui8.buffer);
UTIF._binBE.i32  = new Int32Array  (UTIF._binBE.ui8.buffer);
UTIF._binBE.ui32 = new Uint32Array (UTIF._binBE.ui8.buffer);
UTIF._binBE.fl32 = new Float32Array(UTIF._binBE.ui8.buffer);
UTIF._binBE.fl64 = new Float64Array(UTIF._binBE.ui8.buffer);

UTIF._binLE = {
	nextZero   : UTIF._binBE.nextZero,
	readUshort : function(buff, p) {  return (buff[p+1]<< 8) |  buff[p];  },
	readShort  : function(buff, p) {  var a=UTIF._binBE.ui8;  a[0]=buff[p+0];  a[1]=buff[p+1];                                    return UTIF._binBE. i16[0];  },
	readInt    : function(buff, p) {  var a=UTIF._binBE.ui8;  a[0]=buff[p+0];  a[1]=buff[p+1];  a[2]=buff[p+2];  a[3]=buff[p+3];  return UTIF._binBE. i32[0];  },
	readUint   : function(buff, p) {  var a=UTIF._binBE.ui8;  a[0]=buff[p+0];  a[1]=buff[p+1];  a[2]=buff[p+2];  a[3]=buff[p+3];  return UTIF._binBE.ui32[0];  },
	readASCII  : UTIF._binBE.readASCII,
	readFloat  : function(buff, p) {  var a=UTIF._binBE.ui8;  for(var i=0;i<4;i++) a[i]=buff[p+  i];  return UTIF._binBE.fl32[0];  },
	readDouble : function(buff, p) {  var a=UTIF._binBE.ui8;  for(var i=0;i<8;i++) a[i]=buff[p+  i];  return UTIF._binBE.fl64[0];  }
}
UTIF._copyTile = function(tb, tw, th, b, w, h, xoff, yoff)
{
	//console.log("copyTile", tw, th,  w, h, xoff, yoff);
	var xlim = Math.min(tw, w-xoff);
	var ylim = Math.min(th, h-yoff);
	for(var y=0; y<ylim; y++)
	{
		var tof = (yoff+y)*w+xoff;
		var sof = y*tw;
		for(var x=0; x<xlim; x++) b[tof+x] = tb[sof+x];
	}
}

})(UTIF, pako);
})();// Copyright 2011 Google Inc.
//
// This code is licensed under the same terms as WebM:
//  Software License Agreement:  http://www.webmproject.org/license/software/
//  Additional IP Rights Grant:  http://www.webmproject.org/license/additional/
// -----------------------------------------------------------------------------
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND 
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED 
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. 
// IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, 
// INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, 
// BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, 
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY 
// OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING 
// NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, 
// EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//
// -----------------------------------------------------------------------------
//
// Copyright 2011-2013 Dominik Homberger
// Libwebp Javascript / libwebpjs - the libwebp implementation in javascript (v0.2.0)
//
// Author: Dominik Homberger (dominik.homberger@gmail.com)

(function() {

function memmove(destination, destination_off, source, source_off, num) {
	//copy from last to start
	var i; var temp=[];
	for(i=num-1;i>=0;--i) {
		temp[i]=source[source_off+i];
	}
	for(i=num-1;i>=0;--i) {
		destination[destination_off+i]=temp[i];
	}
}

var ca=void 0,p=null,s=0,x=0,la=s,E=s,bb=0,Mb=0;function M(F){return JSON.parse(JSON.stringify(F))}function N(F,G,w,D,S){for(i=0;i<S;++i)F[G+i]=w[D+i]}function Nb(F){var G=[],w=F.length,D;for(D=0;D<w;++D)G.push(F[D]);return G}function ic(F,G){var w=[];w.push(M(F));var D;for(D=0;D<G;++D)w.push(M(F));w.push(0);return w}function rc(F,G){var w=[],D;for(D=0;D<G;++D)w.push(F);w.push(0);return w}function jd(F,G,w,D){var S;for(S=0;S<D;++S)F[G+S]=w}
function kd(F,G,w,D){var S="",ga;for(ga=0;ga<D;++ga)S+=String.fromCharCode(F[G+ga]);return w==S?0:1}function U(F,G){var w,D=[];for(w=0;w<F;++w)D.push(G);return D}function ld(F,G){var w,D=[];for(w=0;w<F;++w)D.push(M(G));return D}function md(F,G){var w;for(w=F.length-1;0<=w;--w)G=M(U(F[w],G));return G}function $(F){if(!F)throw Error("assert :P");}
window.WebPDecoder=function(){function F(a){return a==Ob||a==Pb||a==Bb||a==Qb}function G(a){return S(a,1)}function w(a,b){var c=1+((a.la-1)*b>>8),d=c<<8,e=s;a.Z>=d?(e=1,a.la-=c,a.Z-=d):(e=0,a.la=c);for(;128>a.la;)a.Z<<=1,a.la<<=1,8==++a.gc&&(a.gc=0,a.bc&&(a.Z+=a.qa[a.Ia++],a.bc--));return e}function D(a,b,c,d){d-=c;2<=d?(a.Z=b[c+0]<<8|b[c+1],a.qa=b,a.Ia=c+2,a.bc=d-2):(a.Z=0,a.qa=p,a.bc=0);a.la=255;a.gc=0}function S(a,b){for(var c=0,d=s,d=b-1;0<=d;d--)c|=w(a,128)<<d;return c}function ga(a,b){var c=
S(a,b);return G(a)?-c:c}function Rb(a,b,c,d){var e=Mb;$(a!=p);$(b!=p);$(4294967288>d);a.qa=b;a.Ia=c;a.ya=d;a.T=0;a.Q=0;a.g=0;a.L=0;for(e=a.fa=0;4>e&&e<a.ya;++e)a.T|=a.qa[a.Ia+a.Q]<<8*e,++a.Q}function Sb(a){for(;8<=a.g&&a.Q<a.ya;)a.T>>>=8,a.T+=a.qa[a.Ia+a.Q]<<24>>>0,++a.Q,a.g-=8}function Da(a){8<=a.g&&Sb(a);a.Q==a.ya&&32==a.g&&(a.L=1)}function T(a,b){var c=0;$(0<=b);if(!a.L&&b<gf){if(a.Q==a.ya&&32<=a.g+b&&(a.L=1,32<a.g+b))return c;c=a.T>>a.g&hf[b];a.g+=b;8<=a.g&&8<=a.g&&Sb(a)}else a.fa=1;return c}
function ma(a){return a.Pa==a.gb}function nd(a,b){$(a!=p);if(0==b)return 0;a.gb=2*b-1;a.Y=ld(a.gb,jf);if(a.Y==p)return 0;a.Y[0].s=-1;return a.Pa=1}function ja(a){a!=p&&(a.Y=p,a.Y=p,a.gb=0,a.Pa=0)}function jc(a,b,c,d){for(var e=a.Y,g=0,k=+a.gb;0<d--;){if(g>=k)return 0;if(0>e[g].s){if(ma(a))return 0;var h=a,n=h.Y,l=+h.Pa;e[g].s=l-g;h.Pa+=2;n[l+0].s=-1;n[l+1].s=-1}else if(0==e[g].s)return 0;g+=e[g].s+(c>>d&1)}if(0>e[g].s)e[g].s=0;else if(0!=e[g].s)return 0;e[g].kc=b;return 1}function od(a,b,c){var d=
s,e=0,g=0;$(a!=p);$(b!=p);for(d=0;d<c;++d)0<b[d]&&(++e,g=d);if(!nd(a,e))return 0;if(1==e)return 0>g||g>=c?(ja(a),0):jc(a,g,0,0);e=0;g=U(c,s);if(g==p)return(e=e&&ma(a))||ja(a),e;var k=s,k=s,d=U(Tb+1,0),h=s,n=U(Tb+1,0),l=0;$(b!=p);$(0<c);$(g!=p);for(k=0;k<c;++k)b[k]>l&&(l=b[k]);if(l>Tb)d=0;else{for(k=0;k<c;++k)++d[b[k]];h=d[0]=0;n[0]=-1;for(k=1;k<=l;++k)h=h+d[k-1]<<1,n[k]=h;for(k=0;k<c;++k)g[k]=0<b[k]?n[b[k]]++:pd;d=1}if(!d)return(e=e&&ma(a))||ja(a),e;for(d=0;d<c;++d)if(0<b[d]&&!jc(a,d,g[d],b[d]))return(e=
e&&ma(a))||ja(a),e;(e=ma(a))||ja(a);return e}function Ea(a,b,c,d,e,g,k){for(var h=s,h=0;h<k;++h)e[g+h]=a[b+h]+c[d+h]&255}function qd(a,b,c){var d=a.P.l;if(!(c=0>b||0>c||b+c>a.P.v))if(c=0==b){a:{var e=a.Ga,g=a.G,k=a.ub;c=a.P.l;var h=a.P.v,n=a.Xb,l=[p],m=p,f=h*c,q=p,r=p,r="WEBP_FILTER_TYPE",u=s,l=s,v=0,C=s;$(0<c&&0<h&&d>=c);$(e!=p&&n!=p);if(k<=Ub)c=0;else if(C=e[g+0]>>0&3,r=e[g+0]>>2&3,u=e[g+0]>>4&3,l=e[g+0]>>6&3,C<kc||C>kf||r>=lf||u>rd||0!=l)c=0;else{if(C==kc)v=k>=f,l=e,m=g+Ub;else{l=U(f,0);m=0;if(l==
p){c=0;break a}var v=g+Ub,k=k-Ub,g=l,q=M(Vb),A=0,z=sd();z==p?v=0:(z.l=c,z.v=h,z.N=q,td(na),q.put=ud,q.Mb=vd,q.Pb=wd,q.ka=p,q.ka=g,q.fd=0,q.width=c,q.height=h,z.a=L,Rb(z.o,e,v,k),z.Wa=Cb,Ka(c,h,1,z,p)&&xd(z,c)&&(z.Wa=Db,A=lc(z,z.V,z.Ha,z.l,z.v,mf)),z!=p&&sa(z),v=A)}if(v){e=nf[r];e!=p?(q=U(f,0),r=0,q==p&&(v=0,C!=kc&&(m=l=p)),e(l,m,c,h,1,c,q,r),f=q,C=r):(f=l,C=m);for(e=0;0<h--;)N(n,e,f,C,c),C+=c,e+=d;u==rd&&(v=l==p||0>=m||0>=c?0:1)}c=v}}c=!c}return c?p:0==b?a.Xb:+b*d}function of(a){var b=a.width,c=a.height,
d=a.J;if(0>=b||0>=c||!(d>=Qa&&d<Cc))return ta;if(!a.Fc&&a.Jb==p){var e=p,g=0,k=0,h=0,n=0,e=bb,l=b*yd[d],m=l*c;d<ua||(g=parseInt((b+1)/2,10),h=g*parseInt((c+1)/2,10),d==Ra&&(k=b,n=k*c));e=m+2*h+n;if(e!=e)return ta;e=U(e,205);if(e==p)return cb;a.Jb=e;a.jc=p;d<ua?(b=a.c.RGBA,b.ma=e,b.Sa=p,b.f=l,b.size=m):(b=a.c.Va,b.y=e,b.D=p,b.F=l,b.Wc=m,b.c=e,b.B=p+m,b.nb=g,b.Rc=h,b.S=e,b.C=p+m+h,b.rb=g,b.Uc=h,d==Ra&&(b.p=e,b.q=p+m+2*h),b.Wb=n,b.Fa=k)}d=1;g=a.J;k=a.width;h=a.height;g>=Qa&&g<Cc?g<ua?(a=a.c.RGBA,d&=
a.f*h<=a.size,d&=a.f>=k*yd[g],d&=a.ma!=p):(a=a.c.Va,n=a.nb*parseInt((h+1)/2,10),l=a.rb*parseInt((h+1)/2,10),m=a.Fa*h,d&=a.F*h<=a.Wc,d&=n<=a.Rc,d&=l<=a.Uc,d&=m<=a.Wb,d&=a.F>=k,d&=a.nb>=parseInt((k+1)/2,10),d&=a.rb>=parseInt((k+1)/2,10),d&=a.y!=p,d&=a.c!=p,d&=a.S!=p,g==Ra&&(d&=a.Fa>=k,d&=m<=a.Wb,d&=a.p!=p)):d=0;return d?L:ta}function zd(a,b,c,d){if(d==p||0>=a||0>=b)return ta;if(c!=p){if(c.Ua){var e=c.wc,g=c.vc,k=c.t&-2,h=c.k&-2;if(0>k||0>h||0>=e||0>=g||k+e>a||h+g>b)return ta;a=e;b=g}if(c.I){if(0>=c.Ba||
0>=c.Aa)return ta;a=c.Ba;b=c.Aa}}d.width=a;d.height=b;return of(d)}function mb(a){return!(a&-256)?a:0>a?0:255}function Ad(a,b,c,d){var e=U(16,0),g;g=0;var k;for(k=0;4>k;++k){var h=a[b+0]+a[b+8],n=a[b+0]-a[b+8],l=(a[b+4]*Wb>>16)-(a[b+12]*Xb>>16),m=(a[b+4]*Xb>>16)+(a[b+12]*Wb>>16);e[g+0]=h+m;e[g+1]=n+l;e[g+2]=n-l;e[g+3]=h-m;g+=4;b++}for(k=g=0;4>k;++k)a=e[g+0]+4,h=a+e[g+8],n=a-e[g+8],l=(e[g+4]*Wb>>16)-(e[g+12]*Xb>>16),m=(e[g+4]*Xb>>16)+(e[g+12]*Wb>>16),c[d+0+0*f]=mb(c[d+0+0*f]+(h+m>>3)),c[d+1+0*f]=mb(c[d+
1+0*f]+(n+l>>3)),c[d+2+0*f]=mb(c[d+2+0*f]+(n-l>>3)),c[d+3+0*f]=mb(c[d+3+0*f]+(h-m>>3)),g++,d+=f}function pf(a,b,c,d,e){Ad(a,b,c,d);e&&Ad(a,b+16,c,d+4)}function qf(a,b,c,d){mc(a,b+0,c,d+0,1);mc(a,b+32,c,d+4*f,1)}function nc(a,b,c,d){a=a[b+0]+4;var e;for(e=0;4>e;++e)for(b=0;4>b;++b)c[d+b+e*f]=mb(c[d+b+e*f]+(a>>3))}function rf(a,b,c,d){a[b+0]&&nc(a,b+0,c,d+0);a[b+16]&&nc(a,b+16,c,d+4);a[b+32]&&nc(a,b+32,c,d+4*f);a[b+48]&&nc(a,b+48,c,d+4*f+4)}function Dc(a,b,c){var d=b-f,e=oa,g=255-a[d-1],k;for(k=0;k<
c;++k){var h=e,n=g+a[b-1],l;for(l=0;l<c;++l)a[b+l]=h[n+a[d+l]];b+=f}}function Yb(a,b,c){var d;for(d=0;16>d;++d)for(i=0;16>i;++i)b[c+d*f+i]=a}function y(a,b,c){return a+2*b+c+2>>2}function Zb(a,b,c){var d,e;for(d=0;8>d;++d)for(e=0;8>e;++e)b[c+e+d*f]=a}function nb(a,b,c){var d=a[b-c],e=a[b+0],g=3*(e-d)+sc[1020+a[b-2*c]-a[b+c]],k=oc[112+(g+4>>3)];a[b-c]=oa[255+d+oc[112+(g+3>>3)]];a[b+0]=oa[255+e-k]}function Bd(a,b,c,d){var e=a[b+0],g=a[b+c];return va[255+a[b-2*c]-a[b-c]]>d||va[255+g-e]>d}function Cd(a,
b,c,d,e){var g=a[b-3*c],k=a[b-2*c],h=a[b-c],n=a[b+0],l=a[b+c],m=a[b+2*c],f=a[b+3*c];return 2*va[255+h-n]+tc[255+k-l]>d?0:va[255+a[b-4*c]-g]<=e&&va[255+g-k]<=e&&va[255+k-h]<=e&&va[255+f-m]<=e&&va[255+m-l]<=e&&va[255+l-n]<=e}function Dd(a,b,c,d){var e;for(e=0;16>e;++e)2*va[255+a[b+e-c]-a[b+e+0]]+tc[255+a[b+e-2*c]-a[b+e+c]]<=d&&nb(a,b+e,c)}function Ed(a,b,c,d){var e;for(e=0;16>e;++e)2*va[255+a[b+e*c-1]-a[b+e*c+0]]+tc[255+a[b+e*c-2]-a[b+e*c+1]]<=d&&nb(a,b+e*c,1)}function sf(a,b,c,d){var e;for(e=3;0<e;--e)b+=
4*c,Dd(a,b+0,c,d)}function tf(a,b,c,d){var e;for(e=3;0<e;--e)b+=4,Ed(a,b+0,c,d)}function Fa(a,b,c,d,e,g,k,h){for(;0<e--;){if(Cd(a,b+0,c,g,k))if(Bd(a,b+0,c,h))nb(a,b+0,c);else{var n=a,l=b+0,m=c,f=n[l-2*m],q=n[l-m],r=n[l+0],u=n[l+m],v=n[l+2*m],C=sc[1020+3*(r-q)+sc[1020+f-u]],A=27*C+63>>7,z=18*C+63>>7,C=9*C+63>>7;n[l-3*m]=oa[255+n[l-3*m]+C];n[l-2*m]=oa[255+f+z];n[l-m]=oa[255+q+A];n[l+0]=oa[255+r-A];n[l+m]=oa[255+u-z];n[l+2*m]=oa[255+v-C]}b+=d}}function Ga(a,b,c,d,e,g,k,h){for(;0<e--;){if(Cd(a,b+0,c,
g,k))if(Bd(a,b+0,c,h))nb(a,b+0,c);else{var n=a,l=b+0,m=c,f=n[l-m],q=n[l+0],r=n[l+m],u=3*(q-f),v=oc[112+(u+4>>3)],u=oc[112+(u+3>>3)],C=v+1>>1;n[l-2*m]=oa[255+n[l-2*m]+C];n[l-m]=oa[255+f+u];n[l+0]=oa[255+q-v];n[l+m]=oa[255+r-C]}b+=d}}function uf(a,b,c,d,e,g){Fa(a,b+0,c,1,16,d,e,g)}function vf(a,b,c,d,e,g){Fa(a,b+0,1,c,16,d,e,g)}function wf(a,b,c,d,e,g){var k;for(k=3;0<k;--k)b+=4*c,Ga(a,b+0,c,1,16,d,e,g)}function xf(a,b,c,d,e,g){var k;for(k=3;0<k;--k)b+=4,Ga(a,b+0,1,c,16,d,e,g)}function yf(a,b,c,d,e,
g,k,h){Fa(a,b,e,1,8,g,k,h);Fa(c,d,e,1,8,g,k,h)}function zf(a,b,c,d,e,g,k,h){Fa(a,b,1,e,8,g,k,h);Fa(c,d,1,e,8,g,k,h)}function Af(a,b,c,d,e,g,k,h){Ga(a,b+4*e,e,1,8,g,k,h);Ga(c,d+4*e,e,1,8,g,k,h)}function Bf(a,b,c,d,e,g,k,h){Ga(a,b+4,1,e,8,g,k,h);Ga(c,d+4,1,e,8,g,k,h)}function Fd(a,b){return b==$b?0==a.i?0==a.d?Cf:Df:0==a.d?Ef:$b:b}function Ec(a,b,c,d){for(i=0;4>i;++i)a[b+i]=c[d+i]}function wa(a,b){return 0>a?0:a>b?b:a}function Gd(a){a.a="VP8_STATUS_OK";a.xc="OK"}function td(a){a>>>8!=na>>>8&&alert("mismatch error")}
function Y(a,b,c){a.a==L&&(a.a=b,a.xc=c,a.za=0);alert(b+": "+c);return 0}function Hd(a,b){var c=[0],d=x,e=[Mb],g=M(Id),k=M(Jd),h=M(Fc),e="VP8StatusCode",g=M(Gc);if(a==p)return alert("(dec == null)"),0;Gd(a);if(b==p)return Y(a,"VP8_STATUS_INVALID_PARAM","null VP8Io passed to VP8GetHeaders()");g.data=b.data;g.b=b.b;g.e=b.e;g.b=[g.b];g.e=[g.e];g=[g];e=Kd(g);if(e!=L)return Y(a,e,"Incorrect/incomplete header.");g=g[0];g.b=g.b[0];g.e=g.e[0];if(g.ia)return Y(a,W,"Unexpected lossless format encountered.");
a.Ga==p&&($(0==a.ub),a.Ga=g.$,a.G=g.G,a.ub=g.pa);d=g.data;c=g.b+g.offset;e=g.e-g.offset;$(g.e>=g.offset);if(4>e[0])return Y(a,Z,"Truncated header.");h=d[c+0]|d[c+1]<<8|d[c+2]<<16;g=a.Ac;g.fb=!(h&1)+0;g.Jc=h>>1&7;g.Nc=h>>4&1;g.Ra=h>>5;if(3<g.Jc)return Y(a,"VP8_STATUS_BITSTREAM_ERROR","Incorrect keyframe parameters.");if(!g.Nc)return Y(a,"VP8_STATUS_UNSUPPORTED_FEATURE","Frame not displayable.");c+=3;e-=3;k=a.P;if(g.fb){if(7>e)return Y(a,"VP8_STATUS_NOT_ENOUGH_DATA","cannot parse picture header");if(!(3<=
e&&157==d[c+0]&&1==d[c+1]&&42==d[c+2]))return Y(a,"VP8_STATUS_BITSTREAM_ERROR","Bad code word");k.l=(d[c+4]<<8|d[c+3])&16383;k.gd=d[c+4]>>6;k.v=(d[c+6]<<8|d[c+5])&16383;k.hd=d[c+6]>>6;c+=7;e-=7;a.Ma=k.l+15>>4;a.hb=k.v+15>>4;b.width=k.l;b.height=k.v;b.I=0;b.Ua=0;b.k=0;b.t=0;b.Ka=b.width;b.K=b.height;b.m=b.width;b.h=b.height;h=a.R;for(i=0;i<h.Ta.length;++i)h.Ta[i]=255;h.z=M(Ff);h=a.Ca;$(h!=p);h.pb=0;h.ob=0;h.tb=1;for(i=0;i<h.Kb.length;++i)h.Kb[i]=0;for(i=0;i<h.Cb.length;++i)h.Cb[i]=0;a.Lb=0}if(g.Ra>
e)return Y(a,"VP8_STATUS_NOT_ENOUGH_DATA","bad partition length");h=a.o;D(h,d,c,c+g.Ra);c+=g.Ra;e-=g.Ra;g.fb&&(k.uc=G(h),k.$c=G(h));var k=h,n=a.Ca,l=a.R;$(k!=p);$(n!=p);n.pb=G(k);if(n.pb){n.ob=G(k);if(G(k)){var m;n.tb=G(k);for(m=0;m<xa;++m)n.Kb[m]=G(k)?ga(k,7):0;for(m=0;m<xa;++m)n.Cb[m]=G(k)?ga(k,6):0}if(n.ob)for(m=0;m<Ld;++m)l.Ta[m]=G(k)?S(k,8):255}else n.ob=0;if(k.Ab)return Y(a,"VP8_STATUS_BITSTREAM_ERROR","cannot parse segment header");k=h;n=a.ga;n.Oc=G(k);n.Fb=S(k,6);n.kb=S(k,3);n.oc=G(k);if(n.oc&&
G(k)){for(l=0;l<Hc;++l)G(k)&&(n.Lc[l]=ga(k,6));for(l=0;l<Gf;++l)G(k)&&(n.Gc[l]=ga(k,6))}a.A=0==n.Fb?0:n.Oc?1:2;if(0<a.A)if(a.Ca.pb)for(l=0;l<xa;++l)m=a.Ca.Cb[l],a.Ca.tb||(m+=n.Fb),a.Zb[l]=m;else a.Zb[0]=n.Fb;if(k.Ab)return Y(a,"VP8_STATUS_BITSTREAM_ERROR","cannot parse filter header");var k=d,f=c,n=f,e=f+e;m=0;var q=s,r=s;a.Hb=1<<S(a.o,2);q=a.Hb-1;l=k;m=f+3*q;if(e<m)e="VP8_STATUS_NOT_ENOUGH_DATA";else{for(r=0;r<q;++r){var f=l,u=m+(k[n+0]|k[n+1]<<8|k[n+2]<<16);u>e&&(f=k);D(a.ic[+r],l,m,u);l=f;m=u;
n+=3}D(a.ic[+q],l,m,e);e=m<e?"VP8_STATUS_OK":"VP8_STATUS_SUSPENDED"}if("VP8_STATUS_OK"!=e)return Y(a,"VP8_STATUS_BITSTREAM_ERROR","cannot parse partitions");q=a.o;e=S(q,7);k=G(q)?ga(q,4):0;n=G(q)?ga(q,4):0;l=G(q)?ga(q,4):0;m=G(q)?ga(q,4):0;q=G(q)?ga(q,4):0;r=a.Ca;f=s;for(f=0;f<xa;++f){u=s;if(r.pb)u=r.Kb[f],r.tb||(u+=e);else if(0<f){a.yb[f]=a.yb[0];continue}else u=e;var v=a.yb[f];v.sc[0]=Ic[wa(u+k,127)];v.sc[1]=Jc[wa(u+0,127)];v.sb[0]=2*Ic[wa(u+n,127)];v.sb[1]=101581*Jc[wa(u+l,127)]>>16;8>v.sb[1]&&
(v.sb[1]=8);v.qc[0]=Ic[wa(u+m,117)];v.qc[1]=Jc[wa(u+q,127)]}if(g.fb)a.Zc=259;else return Y(a,Hf,"Not a key frame.");G(h);e=a.R;for(k=0;k<Md;++k)for(n=0;n<Nd;++n)for(l=0;l<Kc;++l)for(m=0;m<Lc;++m)w(h,If[k][n][l][m])&&(e.z[k][n][l][m]=S(h,8));a.pc=G(h);a.pc&&(a.Pc=S(h,8));if(a.P.uc){c-=8;h=Mb;if(8>g.Ra||1!=d[c+8-1])return Y(a,W,"RIFF: Inconsistent extra information.");h=d[c+0]<<0|d[c+1]<<8|d[c+2]<<16;a.fc=h;a.dd=p;a.cd=d[c+3]}return a.za=1}function Mc(a,b,c,d,e,g){var k=b[e][c];if(!w(a,k[0]))return 0;
for(;;){++e;if(w(a,k[1])){var h;if(w(a,k[2])){if(w(a,k[3]))if(w(a,k[6])){h=x;c=w(a,k[8]);k=w(a,k[9+c]);k=2*c+k;c=0;h=Jf[k];var n;for(n=0;n<h.length-1;++n)c+=c+w(a,h[n]);c+=3+(8<<k)}else w(a,k[7])?(c=7+2*w(a,165),c+=w(a,145)):c=5+w(a,159);else c=w(a,k[4])?3+w(a,k[5]):2;k=b[Nc[e]][2]}else k=b[Nc[e]][1],c=1;h=Kf[e-1];g[g[g.length-1]+h]=(w(a,128)?-c:c)*d[(0<h)+0];if(16==e||!w(a,k[0]))return e}else k=b[Nc[e]][0];if(16==e)return 16}}function ob(a,b){return((16777216*a[0]+65536*a[1]+256*a[2]+1*a[3])*Lf&
4278190080)>>b}function Mf(a,b){var c=0;if(a==p)return 0;if(b==p)return Y(a,"VP8_STATUS_INVALID_PARAM","NULL VP8Io parameter in VP8Decode().");if(!a.za&&!Hd(a,b))return 0;$(a.za);var d;if(b.Mb&&!b.Mb(b))Y(a,Nf,"Frame setup failed"),d=a.a;else{b.Za&&(a.A=0);var e=uc[a.A];2==a.A?(a.lb=0,a.mb=0):(a.lb=b.t-e>>4,a.mb=b.k-e>>4,0>a.lb&&(a.lb=0),0>a.mb&&(a.mb=0));a.Ya=b.K+15+e>>4;a.wb=b.Ka+15+e>>4;a.wb>a.Ma&&(a.wb=a.Ma);a.Ya>a.hb&&(a.Ya=a.hb);d=L}if(c=d==L){if(c){var g;b:{a.Ja=0;if(a.qb){var k=a.rc;if(!WebPWorkerReset(k)){g=
Y(a,cb,"thread initialization failed.");break b}k.Qd=a;k.Rd=a.oa.N;k.Ud=FinishRow;a.jb=0<a.A?Od:Od-1}else a.jb=Of;g=1}var h;if(!(h=!g)){var n;b:{var l=a.jb,m=a.Ma,t=4*m,q=32*m,r=m+1,u=0<a.A?m*(a.qb?2:1):0,v=Pf,C=q*(16*l+parseInt(3*uc[a.A]/2,10)),A=a.Ga!=p?a.P.l*a.P.v:0,z=t+q+r+u+v+384+C+A+Pd;if(z!=z)n=0;else{if(z>a.Gb){a.ib=0;a.Gb=0;if(a.ib==p){n=Y(a,"VP8_STATUS_OUT_OF_MEMORY","no memory during frame initialization.");break b}a.Gb=z}a.dc=205;a.Xc=rc(205,16*m);a.Sc=rc(205,8*m);a.Vc=rc(205,8*m);a.M=
u?ic(Oc,u):p;a.Sd=u?0:p;a.oa.ha=0;a.oa.M=a.M;$(0==(v&Pd));a.Ea=rc(205,1*v);a.z=-12851;a.H=16*m;a.r=8*m;var Ha=uc[a.A],G=Ha*a.H,y=Ha/2*a.r;a.ca=U(C,205);a.da=+G;a.aa=a.ca;a.ba=a.da+16*l*a.H+y;a.ra=a.aa;a.sa=a.ba+8*l*a.r+y;a.Xb=A?U(A,x):p;a.La=ic(Qd,r);a.dc=rc($b,t);n=1}}h=!n}if(h)c=0;else{b.width=a.P.l;b.height=a.P.v;b.w=0;b.y=a.ca;b.D=a.da;b.c=a.aa;b.B=a.ba;b.S=a.ra;b.C=a.sa;b.F=a.H;b.Da=a.r;b.p=p;b.q=p;if(!Rd){var B;for(B=-255;255>=B;++B)va[255+B]=0>B?-B:B,tc[255+B]=va[255+B]>>1;for(B=-1020;1020>=
B;++B)sc[1020+B]=-128>B?-128:127<B?127:B;for(B=-112;112>=B;++B)oc[112+B]=-16>B?-16:15<B?15:B;for(B=-255;510>=B;++B)oa[255+B]=0>B?0:255<B?255:B;Rd=1}mc=pf;Pc=qf;Qc=nc;Rc=rf;Sd=uf;Td=vf;Ud=yf;Vd=zf;Wd=wf;Xd=xf;Yd=Af;Zd=Bf;$d=Dd;ae=Ed;be=sf;ce=tf;c=1}}if(c)a:{for(a.d=0;a.d<a.Ya;++a.d){var Qf=a.ic[a.d&a.Hb-1],db=a,F=db.La[0];F.X=0;F.ua=0;jd(db.cc,0,$b,db.cc.length);db.W=(0<db.A&&db.d>=db.mb&&db.d<=db.Ya)+0;for(a.i=0;a.i<a.Ma;a.i++){var D;var H=a,T=Qf,ya=H.o,S=H.La[0],J=H.La[1+H.i];H.Ca.ob&&(H.Lb=!w(ya,
H.R.Ta[0])?0+w(ya,H.R.Ta[1]):2+w(ya,H.R.Ta[2]));J.Nb=H.pc?w(ya,H.Pc):0;var O=H.dc;O[O.length-1]=0+4*H.i;var Sc=H.cc;H.wa=!w(ya,145);if(H.wa)for(var ga=H.Eb,ja=0,Z=ca,Z=0;4>Z;++Z){var V=Sc[Z],R;for(R=0;4>R;++R){var ta=Rf[O[O[O.length-1]+R]][V],za=0;do za=Sf[2*za+w(ya,ta[za])];while(0<za);V=-za;O[O[O.length-1]+R]=V;ga[ja]=V;ja++}Sc[Z]=V}else{var V=w(ya,156)?w(ya,128)?de:ee:w(ya,163)?fe:ge;H.Eb[0]=V;for(za=0;4>za;++za)O[za+O[O.length-1]]=V;for(za=0;4>za;++za)Sc[za]=V}H.Tc=!w(ya,142)?ge:!w(ya,114)?fe:
w(ya,183)?de:ee;if(ya.Ab)D=0;else{if(J.Nb)S.X=J.X=0,H.wa||(S.ua=J.ua=0),H.ja=0,H.Oa=0;else{var ia=ca,ka=ca,sa=ca,wa=Tf,Aa=H.yb[H.Lb],aa=H.z,ma=H.La[0],ua=U(4,0),xa=U(4,0),ea=U(4,0),pb=U(4,0),na=0,Ba=0,pa=ca,qa=ca,Sa=ca,aa=rc(0,384);if(H.wa)sa=0,wa=H.R.z[3];else{var ab=U(16,0),Ca=J.ua+ma.ua;J.ua=ma.ua=(0<Mc(T,H.R.z[1],Ca,Aa.sb,0,ab))+0;for(var sa=1,wa=H.R.z[0],qb=ab,Ta=aa,La=U(16,s),X=s,X=0;4>X;++X){var Da=qb[0+X]+qb[12+X],Ea=qb[4+X]+qb[8+X],Fa=qb[4+X]-qb[8+X],Ga=qb[0+X]-qb[12+X];La[0+X]=Da+Ea;La[8+
X]=Da-Ea;La[4+X]=Ga+Fa;La[12+X]=Ga-Fa}for(X=0;4>X;++X){var Oa=Ta[Ta.length-1],lb=La[0+4*X]+3,Da=lb+La[3+4*X],Ea=La[1+4*X]+La[2+4*X],Fa=La[1+4*X]-La[2+4*X],Ga=lb-La[3+4*X];Ta[Oa+0]=Da+Ea>>3;Ta[Oa+16]=Ga+Fa>>3;Ta[Oa+32]=Da-Ea>>3;Ta[Oa+48]=Ga-Fa>>3;Ta[Ta.length-1]+=64}aa[aa.length-1]=0}ea=Nb(vc[J.X&15]);pb=Nb(vc[ma.X&15]);for(qa=0;4>qa;++qa){for(var Eb=pb[qa],pa=0;4>pa;++pa){var Ca=Eb+ea[pa],Ka=Mc(T,wa,Ca,Aa.sc,sa,aa);ea[pa]=Eb=(0<Ka)+0;xa[pa]=(0!=aa[aa[aa.length-1]+0])+0;ua[pa]=(1<Ka)+0;aa[aa.length-
1]+=16}pb[qa]=Eb;Ba|=ob(xa,24-4*qa);na|=ob(ua,24-4*qa)}ia=ob(ea,24);ka=ob(pb,24);ea=Nb(vc[J.X>>4]);pb=Nb(vc[ma.X>>4]);for(Sa=0;4>Sa;Sa+=2){for(qa=0;2>qa;++qa){Eb=pb[Sa+qa];for(pa=0;2>pa;++pa)Ca=Eb+ea[Sa+pa],Ka=Mc(T,H.R.z[2],Ca,Aa.qc,0,aa),ea[Sa+pa]=Eb=(0<Ka)+0,xa[2*qa+pa]=(0!=aa[aa[aa.length-1]+0])+0,ua[2*qa+pa]=(1<Ka)+0,aa[aa.length-1]+=16;pb[Sa+qa]=Eb}Ba|=ob(xa,8-2*Sa);na|=ob(ua,8-2*Sa)}ia|=ob(ea,20);ka|=ob(pb,20);J.X=ia;ma.X=ka;H.z=aa;H.Oa=na+0;H.ja=na|Ba;J.Nb=!H.ja+0}D=!T.Ab}if(!D){c=Y(a,"VP8_STATUS_NOT_ENOUGH_DATA",
"Premature end-of-file encountered."+a.i+" "+a.d);break a}var P=a,da=P.Ea,Ma=Tc,Ua=P.Ea,Va=Uc,Wa=P.Ea,Xa=he;if(0<P.i){for(var ba=ca,ba=-1;16>ba;++ba)Ec(da,Ma+ba*f-4,da,Ma+ba*f+12);for(ba=-1;8>ba;++ba)Ec(Ua,Va+ba*f-4,Ua,Va+ba*f+4),Ec(Wa,Xa+ba*f-4,Wa,Xa+ba*f+4)}else{for(ba=0;16>ba;++ba)da[Ma+ba*f-1]=129;for(ba=0;8>ba;++ba)Ua[Va+ba*f-1]=129,Wa[Xa+ba*f-1]=129;0<P.d&&(da[Ma-1-f]=Ua[Va-1-f]=Wa[Xa-1-f]=129)}var Qa=P.Xc,Ra=16*+P.i,mb=P.Sc,vb=8*+P.i,wb=P.Vc,xb=8*+P.i,Za=P.z,fa=ca;if(0<P.d)N(da,Ma-f,Qa,Ra,
16),N(Ua,Va-f,mb,vb,8),N(Wa,Xa-f,wb,xb,8);else if(0==P.i){for(i=0;21>i;++i)da[Ma-f-1+i]=127;for(i=0;9>i;++i)Ua[Va-f-1+i]=127;for(i=0;9>i;++i)Wa[Xa-f-1+i]=127}if(P.wa){var Ya=Ma-f+16;0<P.d&&(P.i>=P.Ma-1?da[Ya+0]=da[Ya+1]=da[Ya+2]=da[Ya+3]=Qa[Ra+15]:N(da,Ya+0,Qa,Ra+16,4));for(var Fb=0;4>Fb;++Fb)da[Fb+Ya+4*f]=da[Fb+Ya+4*f]=da[Fb+Ya+8*f]=da[Fb+Ya+12*f]=da[Fb+Ya+0];for(fa=0;16>fa;fa++){var ac=da,bc=Ma+ie[fa];Uf[P.Eb[fa]](ac,bc);P.Oa&1<<fa?mc(Za,16*+fa,ac,bc,0):P.ja&1<<fa&&Qc(Za,16*+fa,ac,bc)}}else{var $a=
Fd(P,P.Eb[0]);Vf[$a](da,Ma);if(P.ja)for(fa=0;16>fa;fa++)ac=da,bc=Ma+ie[fa],P.Oa&1<<fa?mc(Za,16*+fa,ac,bc,0):P.ja&1<<fa&&Qc(Za,16*+fa,ac,bc)}$a=Fd(P,P.Tc);je[$a](Ua,Va);je[$a](Wa,Xa);if(P.ja&983040){var zb=P.z,Pa=256;P.Oa&983040?Pc(zb,Pa,Ua,Va):Rc(zb,Pa,Ua,Va)}if(P.ja&15728640){var Ab=P.z,Pa=320;P.Oa&15728640?Pc(Ab,Pa,Wa,Xa):Rc(Ab,Pa,Wa,Xa)}P.d<P.hb-1&&(N(Qa,Ra,da,Ma+15*f,16),N(mb,vb,Ua,Va+7*f,8),N(wb,xb,Wa,Xa+7*f,8));var Q=a;if(0<Q.A){var kb=Q.M[1+Q.i],Kb=Q.La[1+Q.i].Nb,ha=Q.Zb[Q.Lb];Q.ga.oc&&(ha+=
Q.ga.Lc[0],Q.wa&&(ha+=Q.ga.Gc[0]));ha=0>ha?0:63<ha?63:ha;kb.zc=ha;0<Q.ga.kb&&(ha=4<Q.ga.kb?ha>>2:ha>>1,ha>9-Q.ga.kb&&(ha=9-Q.ga.kb));kb.yc=1>ha?1:ha;kb.ab=(!Kb||Q.wa)+0}for(var Ia=ca,Bb=8*Q.Ja*Q.r,Qb=Q.ca,Ub=Q.da+16*Q.i+16*Q.Ja*Q.H,Wb=Q.aa,Xb=Q.ba+8*Q.i+Bb,Yb=Q.ra,Zb=Q.sa+8*Q.i+Bb,Ia=0;16>Ia;++Ia)N(Qb,Ub+Ia*Q.H,Q.Ea,+Tc+Ia*f,16);for(Ia=0;8>Ia;++Ia)N(Wb,Xb+Ia*Q.r,Q.Ea,+Uc+Ia*f,8),N(Yb,Zb+Ia*Q.r,Q.Ea,+he+Ia*f,8)}var K=a,I=b,cc=1,eb=K.oa;if(K.qb){var nb=K.rc,cc=cc&WebPWorkerSync(nb);$(nb.a==OK);if(cc){eb.N=
I;eb.ha=K.Ja;eb.d=K.d;eb.W=K.W;if(eb.W){var hc=eb.M;eb.M=K.M;K.M=hc}WebPWorkerLaunch(nb);++K.Ja==K.jb&&(K.Ja=0)}}else{eb.d=K.d;eb.W=K.W;b:{var Hb=1,rb=K.oa,ib=uc[K.A],yb=ib*K.H,dc=parseInt(ib/2)*K.r,Ib=16*rb.ha*K.H,jb=8*rb.ha*K.r,Jb=K.ca,Lb=K.da-yb+Ib,Ob=K.aa,Pb=K.ba-dc+jb,Rb=K.ra,Sb=K.sa-dc+jb,jc=0==rb.d,Tb=(rb.d>=K.hb-1)+0,ra=16*rb.d,fb=16*(rb.d+1);if(rb.W){var pc=K,wc=s,kc=pc.oa.d;$(pc.oa.W);for(wc=pc.lb;wc<pc.wb;++wc){var Na=pc,ec=wc,Vb=kc,xc=Na.oa,gb=Na.H,fc=xc.M[1+ec],sb=Na.ca,tb=Na.da+16*xc.ha*
gb+16*ec,Gb=fc.zc,hb=fc.yc,Ja=2*Gb+hb;if(0!=Gb)if(1==Na.A)0<ec&&ae(sb,tb,gb,Ja+4),fc.ab&&ce(sb,tb,gb,Ja),0<Vb&&$d(sb,tb,gb,Ja+4),fc.ab&&be(sb,tb,gb,Ja);else{var gc=Na.r,yc=Na.aa,zc=Na.ba+8*xc.ha*gc+8*ec,Ac=Na.ra,Bc=Na.sa+8*xc.ha*gc+8*ec,ub=Na.Ac.fb?40<=Gb?2:15<=Gb?1:0:40<=Gb?3:20<=Gb?2:15<=Gb?1:0;0<ec&&(Td(sb,tb,gb,Ja+4,hb,ub),Vd(yc,zc,Ac,Bc,gc,Ja+4,hb,ub));fc.ab&&(Xd(sb,tb,gb,Ja,hb,ub),Zd(yc,zc,Ac,Bc,gc,Ja,hb,ub));0<Vb&&(Sd(sb,tb,gb,Ja+4,hb,ub),Ud(yc,zc,Ac,Bc,gc,Ja+4,hb,ub));fc.ab&&(Wd(sb,tb,gb,
Ja,hb,ub),Yd(yc,zc,Ac,Bc,gc,Ja,hb,ub))}}}if(I.put){jc?(I.y=K.ca,I.D=K.da+Ib,I.c=K.aa,I.B=K.ba+jb,I.S=K.ra,I.C=K.sa+jb):(ra-=ib,I.y=Jb,I.D=Lb,I.c=Ob,I.B=Pb,I.S=Rb,I.C=Sb);Tb||(fb-=ib);fb>I.K&&(fb=I.K);if(K.Ga!=p&&ra<fb&&(0==ra?(I.p=qd(K,ra,fb-ra),I.q=0):I.q=qd(K,ra,fb-ra),I.p==p)){cc=Y(K,W,"Could not decode alpha data.");break b}if(ra<I.k){var qc=I.k-ra,ra=I.k;$(!(qc&1));I.D+=K.H*qc;I.B+=K.r*(qc>>1);I.C+=K.r*(qc>>1);I.p!=p&&(I.q+=I.width*qc)}ra<fb&&(I.D+=I.t,I.B+=I.t>>1,I.C+=I.t>>1,I.p!=p&&(I.q+=I.t),
I.w=ra-I.k,I.m=I.Ka-I.t,I.h=fb-ra,Hb=I.put(I))}rb.ha+1==K.jb&&!Tb&&(N(K.ca,K.da-yb,Jb,Lb+16*K.H,yb),N(K.aa,K.ba-dc,Ob,Pb+8*K.r,dc),N(K.ra,K.sa-dc,Rb,Sb+8*K.r,dc));cc=Hb}}if(!cc){c=Y(a,"VP8_STATUS_USER_ABORT","Output aborted.");break a}}var Cb;if(!(Cb=a.qb&&!WebPWorkerSync(a.rc))){var Db;if(Db=0<a.fc)$(a),$(0<a.fc),Db=!1;Cb=Db}c=Cb?0:1}var lc=c;b.Pb&&b.Pb(b);c=lc&1}if(!c)return ke(a),0;a.za=0;return c}function ke(a){a!=p&&(a.ib&&(a.ib=0),a.ib=p,a.Gb=0,a.za=0)}function Aa(a,b){return a+(1<<b)-1>>b}
function hc(a,b,c,d,e){var g=vb[c]+wb[b]>>ea;b=xb[b];d[e+0]=ia[a+Za[c]-J];d[e+1]=ia[a+g-J];d[e+2]=ia[a+b-J]}function le(a,b,c,d,e){var g=vb[c]+wb[b]>>ea;b=xb[b];d[e+0]=ia[a+Za[c]-J]&248|ia[a+g-J]>>5;d[e+1]=ia[a+g-J]<<3&224|ia[a+b-J]>>3}function me(a,b,c,d,e){d[e+0]=255;hc(a,b,c,d,e+1)}function ne(a,b,c,d,e){var g=xb[b];d[e+0]=Hb[a+Za[c]-J]<<4|Hb[a+(vb[c]+wb[b]>>ea)-J];d[e+1]=15|Hb[a+g-J]<<4}function Vc(a,b,c,d,e){var g=Za[c];c=vb[c]+wb[b]>>ea;d[e+0]=ia[a+xb[b]-J];d[e+1]=ia[a+c-J];d[e+2]=ia[a+g-J]}
function oe(a,b,c,d,e){Vc(a,b,c,d,e);d[e+3]=255}function pe(a,b,c,d,e){hc(a,b,c,d,e);d[e+3]=255}function ib(a,b,c){a[b]=((((a[b]&4278255360)>>>0)+((c&4278255360)>>>0)&4278255360)>>>0|(a[b]&16711935)+(c&16711935)&16711935)>>>0}function ka(a,b){return(((a^b)&4278124286)>>>1)+((a&b)>>>0)>>>0}function $a(a){return 256>a&&0<a?a:0>=a?0:~a>>24&255}function yb(a,b){return $a(a+parseInt((a-b)/2,10))}function Wc(){return qe}function Xc(a,b){a&=255;b&=255;127<a&&(a-=256);127<b&&(b-=256);return a*b>>>5}function re(a,
b,c,d,e,g,k){var h=s,n=8>>a.n,l=a.U,f=a.u;if(8>n){a=(1<<a.n)-1;for(var t=(1<<n)-1,h=b;h<c;++h){b=0;for(var q=s,q=0;q<l;++q)0==(q&a)&&(b=d[e++]>>8&255),g[k++]=f[b&t],b>>=n}}else for(h=b;h<c;++h)for(q=0;q<l;++q)g[k++]=f[d[e++]>>8&255]}function se(a,b,c,d,e){for(c=b+c;b<c;){var g=a[b++];d[e++]=g>>16&255;d[e++]=g>>8&255;d[e++]=g>>0&255;d[e++]=g>>24&255}}function te(a,b,c,d,e){for(c=b+c;b<c;){var g=a[b++];d[e++]=g>>16&240|g>>12&15;d[e++]=g>>0&240|g>>28&15}}function Ib(a,b,c,d,e){for(c=b+c;b<c;){var g=
a[b++];d[e++]=g>>24&255;d[e++]=g>>16&255;d[e++]=g>>8&255;d[e++]=g>>0&255}}function ue(a,b,c,d){if(T(a,8)!=ve)return 0;b[0]=T(a,we)+1;c[0]=T(a,we)+1;d[0]=T(a,1);T(a,Wf);return 1}function xe(a,b){var c=s;if(4>a)return a+1;c=a-2>>1;return(2+(a&1)<<c)+T(b,c)+1}function Oa(a,b){if(b.Q+8>b.ya){var c=a.Y,d=0;for($(c!=p);0!=c[d].s;){var e=c,g=b,k=g.T>>g.g&1;g.L?g.fa=1:(++g.g,8<=g.g&&Sb(g),g.Q==g.ya&&32==g.g&&(g.L=1));d=d+e[d].s+k}return c[d].kc}c=a.Y;d=0;for($(c!=p);0!=c[d].s;)e=c,g=b.T>>b.g&1,++b.g,d=d+
e[d].s+g;return c[d].kc}function zb(a,b){if(a!=p)for(var c=s,d=s,c=0;c<b;++c)for(var e=a[c].va,d=0;d<Yc;++d)ja(e[d])}function ye(a,b,c){b=0==a.eb?0:a.ac[a.bd+a.Ec*(c>>a.eb)+(b>>a.eb)];$(b<a.hc);return a.Db[+b]}function ze(a,b,c,d){var e=a.Na,g=a.O,k=g+b,h=c,f=d;d=a.Xa;c=a.vb;for(N(d,c,h,f,a.l*b);0<e--;){b=a.nc[e];var l=g,m=k,t=h,q=f,f=d,h=c;$(l<m);$(m<=b.Vb);switch(b.Qc){case Ae:t=0;for(b=h+(m-l)*b.U;h<b;){var m=f,q=h,r=m[q]>>8&255,u=(m[q]&16711935)>>>0,u=u+(r<<16|r),u=u&16711935;f[h++]=((m[q]&4278255360)>>>
0|u)>>>0;32==l&&t++}break;case Be:var v=b,C=l,t=m,q=f,r=h,u=v.U;if(0==C){var A=s;ib(q,r,qe);for(A=1;A<u;++A)ib(q,r+A,q[r+A-1]);r+=u;++C}for(var z=(1<<v.n)-1,Ha=Aa(u,v.n),w=v.u,v=+(C>>v.n)*Ha;C<t;){var y=w,B=v,G=p;ib(q,r,q[r-u+0]);G=Ce[y[B++]>>8&15];for(A=1;A<u;++A){var F=E;0==(A&z)&&(G=Ce[y[B++]>>8&15]);F=G(q[r+A-1],q,r+A-u);ib(q,r+A,F)}r+=u;++C;0==(C&z)&&(v+=Ha)}m!=b.Vb&&(b=b.U,N(f,h-b,f,h+(m-l-1)*b,b));break;case De:t=b.U;q=(1<<b.n)-1;r=Aa(t,b.n);u=b.u;for(b=+(l>>b.n)*r;l<m;){A=u;C=b;z=M(Xf);Ha=
s;for(Ha=0;Ha<t;++Ha)0==(Ha&q)&&(w=A[C++],v=z,v.Cc=w>>0&255,v.Bc=w>>8&255,v.Kc=w>>16&255),w=f[h+Ha],v=w>>>8,y=w>>>16,B=w,y+=Xc(z.Cc,v),y&=255,B+=Xc(z.Bc,v),B+=Xc(z.Kc,y),B&=255,f[h+Ha]=(w&4278255360|y<<16|B)>>>0;h+=t;++l;0==(l&q)&&(b+=r)}break;case Ee:t==f&&0<b.n?(t=(m-l)*Aa(b.U,b.n),q=h+(m-l)*b.U-t,
memmove(f,q,f,h,t),
re(b,l,m,f,q,f,h)):re(b,l,m,t,q,f,h)}h=d;f=c}}function Yf(a,b){var c=a.V,d=a.Ha+a.l*a.O,e=b-a.O;if(!(0>=e)){ze(a,e,c,d);var g=a.N,c=a.Xa,k=[a.vb];var d=a.O,e=b,h=k,f=g.width;$(d<e);
$(g.t<g.Ka);e>g.K&&(e=g.K);if(d<g.k){var l=g.k-d,d=g.k;h[0]+=f*l}d>=e?d=0:(h[0]+=g.t,g.w=d-g.k,g.m=g.Ka-g.t,g.h=e-d,d=1);if(d){k=k[0];d=a.Ib;e=g.width;if(d.J<ua){var m=d.c.RGBA,h=m.ma,t=m.Sa+a.xa*m.f;if(g.I)c=EmitRescaledRows(a,c,k,e,g.h,h,t,m.f);else{for(var f=d.J,l=g.m,g=g.h,m=m.f,q=g;0<q--;){var r=c,u=k,v=l,C=h,A=t;switch(f){case Qa:for(v=u+v;u<v;){var z=r[u++];C[A++]=z>>16&255;C[A++]=z>>8&255;C[A++]=z>>0&255}break;case jb:se(r,u,v,C,A);break;case Ob:se(r,u,v,C,A);WebPApplyAlphaMultiply(C,0,v,
1,0);break;case Zc:for(v=u+v;u<v;)z=r[u++],C[A++]=z>>0&255,C[A++]=z>>8&255,C[A++]=z>>16&255;break;case Pa:Ib(r,u,v,C,A);break;case Pb:Ib(r,u,v,C,A);WebPApplyAlphaMultiply(C,0,v,1,0);break;case Ab:Ib(r,u,v,C,A);break;case Bb:Ib(r,u,v,C,A);WebPApplyAlphaMultiply(C,1,v,1,0);break;case kb:te(r,u,v,C,A);break;case Qb:te(r,u,v,C,A);WebPApplyAlphaMultiply4444(C,v,1,0);break;case Fe:for(v=u+v;u<v;)z=r[u++],C[A++]=z>>16&248|z>>13&7,C[A++]=z>>5&224|z>>3&31;break;default:$(0)}k+=e;t+=m}c=g}a.xa+=c}else a.xa=
g.I?EmitRescaledRowsYUVA(a,c,k,e,g.h):EmitRowsYUVA(a,c,k,e,g.m,g.h);$(a.xa<=d.height)}a.O=b;$(a.O<=a.v)}}function lc(a,b,c,d,e,g){var k=1,h=0,f=0,l=a.o,m=a.cb,t=m.Db,q=c,r=c;c+=d*e;e=Ba+Ge;var u=e+m.xb,v=0<m.xb?m.Yb:p,C=m.Dc,A=!1;$(t!=p);a:for(;!l.L&&q<c;){var z=s;A||(0==(h&C)&&(t=ye(m,h,f)),Da(l),z=Oa(t.va[Zf],l));if(z<Ba||A){if(!A){var w=k=A=s,y=s;Da(l);A=Oa(t.va[$f],l);k=z;Da(l);w=Oa(t.va[ag],l);Da(l);y=Oa(t.va[bg],l);b[q]=(y<<24>>>0)+(A<<16)+(k<<8)+w}A=!1;++q;++h;if(h>=d&&(h=0,++f,g!=p&&0==f%
$c&&g(a,f),v!=p))for(;r<q;)k=b[r++],v.ea[ad*k>>>v.bb]=k}else if(z<e){w=w=s;k=xe(z-Ba,l);z=Oa(t.va[cg],l);Da(l);w=xe(z,l);w>He?w-=He:(z=dg[w-1],z=(z>>4)*d+(8-(z&15)),w=1<=z?z:1);z=s;for(z=0;z<k;++z)b[q+z]=b[q+z-w];q+=k;for(h+=k;h>=d;)h-=d,++f,g!=p&&0==f%$c&&g(a,f);if(q<c&&(t=ye(m,h,f),v!=p))for(;r<q;)k=b[r++],v.ea[ad*k>>>v.bb]=k}else if(z<u){A=z-e;for($(v!=p);r<q;)z=b[r++],v.ea[ad*z>>>v.bb]=z;z=b;w=q;y=v;$(A<=-1>>>y.bb);z[w]=y.ea[A];A=!0;continue a}(k=!l.fa)||End}g!=p&&g(a,f);l.fa||!k||l.L&&q<c?(k=
0,a.a=!l.L?W:Ie):q==c&&(a.Ob=Db);return k}function bd(a){$(a);a.ac=p;zb(a.Db,a.hc);var b=a.Yb;b!=p&&(b.ea=p,b.ea=p);$(a)}function sd(){var a=M(eg);if(a==p)return p;a.a=L;a.Wa=cd;a.Ob=cd;return a}function sa(a){var b=s;if(a!=p){bd(a.cb);a.V=p;a.V=p;for(b=0;b<a.Na;++b){var c=a.nc[b];c.u=p;c.u=p}a.Na=0;a.Ub=0;a.Mc=p;a.Mc=p;a.Ib=p}}function Ka(a,b,c,d,e){var g=1;a=[a];b=[b];for(var k=d.o,h=d.cb,f=p,l=p,l=0;;){if(c)for(;g&&T(k,1);){var m=a,t=b,q=d,r=1,u=q.o,g=q.nc[q.Na],v=T(u,2);if(q.Ub&1<<v)g=0;else{q.Ub|=
1<<v;g.Qc=v;g.U=m[0];g.Vb=t[0];g.u=[p];g.b=0;++q.Na;$(q.Na<=Je);switch(v){case Be:case De:g.n=T(u,3)+2;r=Ka(Aa(g.U,g.n),Aa(g.Vb,g.n),0,q,g.u);break;case Ee:t=T(u,8)+1;r=16<t?0:4<t?1:2<t?2:3;m[0]=Aa(g.U,r);g.n=r;if(m=r=Ka(t,1,0,q,g.u))if(m=t,q=g,r=s,t=1<<(8>>>q.n)>>>0,u=Array(t),u==p)m=0;else{var v=q.u[0],C=q.b;u[0]=q.u[0][q.b+0];for(r=1;r<m;++r)u[r]=((((v[C+r]&4278255360)>>>0)+((u[r-1]&4278255360)>>>0)&4278255360)>>>0|(v[C+r]&16711935)+(u[r-1]&16711935)&16711935)>>>0;for(;r<t;++r)u[r]=0;q.u[0]=p;
q.b=p;q.u[0]=u;q.b=0;m=1}r=m;break;case Ae:break;default:$(0)}g.u=g.u[0];g=r}}if(g&&T(k,1)&&(l=T(k,4),g=1<=l&&l<=fg,!g)){d.a=W;break}if(g)a:{var g=d,A=a[0],z=b[0],m=l,C=v=s,C=g.o,q=g.cb,r=[p],t=p,u=1;if(c&&T(C,1)){var v=T(C,3)+2,A=Aa(A,v),w=Aa(z,v),z=A*w;if(!Ka(A,w,0,g,r)){g.a=W;zb(t,u);g=0;break a}r=r[0];q.eb=v;for(v=0;v<z;++v)A=r[v]>>>8&65535,r[v]=A,A>=u&&(u=A+1)}if(C.fa)zb(t,u),g=0;else if($(65536>=u),t=ld(u,gg),t==p)g.a=cb,zb(t,u),g=0;else{for(v=0;v<u;++v){z=t[v].va;for(C=0;C<Yc;++C){A=hg[C];
0==C&&0<m&&(A+=1<<m);b:{var y=A,A=g,G=z[+C],B=0,w=A.o;if(T(w,1)){var F=Array(2),D=Array(2),L=Array(2),B=T(w,1)+1,J=T(w,1);F[0]=T(w,0==J?1:8);D[0]=0;L[0]=B-1;2==B&&(F[1]=T(w,8),D[1]=1,L[1]=B-1);c:{var J=0,H=s;$(G!=p);$(L!=p);$(D!=p);$(F!=p);if(nd(G,B)){for(H=0;H<B;++H)if(D[H]!=pd){if(0>F[H]||F[H]>=y){(J=J&&ma(G))||ja(G);B=J;break c}if(!jc(G,F[H],D[H],L[H])){(J=J&&ma(G))||ja(G);B=J;break c}}(J=(J=1)&&ma(G))||ja(G);B=J}else B=0}}else{B=s;D=[];F=T(w,4)+4;if(F>Ke){A.a=W;A=0;break b}L=Array(y);if(L==p){A.a=
cb;A=0;break b}for(B=0;B<F;++B)D[ig[B]]=T(w,3);c:{var B=A,O=D,D=y,F=L,J=0,H=B.o,S=s,V=s,Y=jg,Z=M(Le);if(od(Z,O,Ke)){if(T(H,1)){if(S=2+2*T(H,3),V=2+T(H,S),V>D){B.a=W;ja(Z);B=J;break c}}else V=D;for(S=0;S<D;){var R=s;if(0==V--)break;Da(H);R=Oa(Z,H);if(R<Me)F[S++]=R,0!=R&&(Y=R);else{var O=R==kg,R=R-Me,ea=lg[R],R=T(H,mg[R])+ea;if(S+R>D){B.a=W;ja(Z);B=J;break c}for(O=O?Y:0;0<R--;)F[S++]=O}}J=1;ja(Z);B=J}else B.a=W,B=0}B&&(B=od(G,L,y))}(B=B&&!w.fa)?A=1:(A.a=W,A=0)}if(!A){zb(t,u);g=0;break a}}}q.ac=r;q.hc=
u;q.Db=t;g=1}}if(!g){d.a=W;break}if(0<l){if(h.xb=1<<l,m=h.Yb,q=1<<l,$(m!=p),$(0<l),m.ea=U(q,0),m.ea==p?l=0:(m.bb=32-l,l=1),!l){d.a=cb;g=0;break}}else h.xb=0;l=d;m=a[0];q=b[0];r=l.cb;t=r.eb;l.l=m;l.v=q;r.Ec=Aa(m,t);r.Dc=0==t?-1:(1<<t)-1;if(c){d.Ob=Cb;break}f=Array(a*b);l=0;if(f==p){d.a=cb;g=0;break}g=(g=lc(d,f,l,a,b,p))&&!k.fa;break}g?(e!=p?e[0]=f:($(f==p),$(c)),c||bd(h)):(bd(h),d.a==W&&d.o.L&&(d.a=Ie));return g}function xd(a,b){var c=a.l*a.v,d=c+b+b*$c;$(a.l<=b);a.V=Array(d);a.Ha=0;if(a.V==p)return a.Xa=
p,a.a=cb,0;a.Xa=a.V;a.vb=a.Ha+c+b;return 1}function mf(a,b){var c=b-a.O,d=a.V,e=a.Ha+a.l*a.O;if(!(0>=c)){ze(a,c,d,e);for(var e=a.N.width,c=e*c,d=a.N.ka,e=a.N.fd+e*a.O,g=a.Xa,k=a.vb,h=s,h=0;h<c;++h)d[e+h]=g[k+h]>>>8&255;a.O=a.xa=b}}function ng(a,b){var c=[s],d=[s],e=[s];if(a==p)return 0;if(b==p)return a.a=ta,0;a.N=b;a.a=L;Rb(a.o,b.data,b.b,b.e);if(!ue(a.o,c,d,e))return a.a=W,sa(a),$(a.a!=L),0;a.Ob=cd;b.width=c[0];b.height=d[0];a.Wa=Cb;return!Ka(c[0],d[0],1,a,p)?(sa(a),$(a.a!=L),0):1}function og(a){var b=
p,c=p;if(a==p)return 0;b=a.N;$(b!=p);c=b.ka;$(c!=p);a.Ib=c.j;a.Hc=c.Hc;$(a.Ib!=p);if(!Ne(c.Qa,b,Pa))return a.a=ta,sa(a),$(a.a!=L),0;if(!xd(a,b.width)||b.I&&!AllocateAndInitRescaler(a,b))return sa(a),$(a.a!=L),0;a.Wa=Db;if(!lc(a,a.V,a.Ha,a.l,a.v,Yf))return sa(a),$(a.a!=L),0;c.ec=a.xa;sa(a);return 1}function wa(a,b){return 0>a?0:a>b?b:a}function ab(a,b,c,d,e,g,k,h,f,l,m,t,q,r,u,v,C,w,z){var y,G=C-1>>1,F=e[g+0]|k[h+0]<<16,B=f[l+0]|m[t+0]<<16;if(a){var D=3*F+B+131074>>2;w(a[b+0],D&255,D>>16,q,r)}c&&(D=
3*B+F+131074>>2,w(c[d+0],D&255,D>>16,u,v));for(y=1;y<=G;++y){var J=e[g+y]|k[h+y]<<16,L=f[l+y]|m[t+y]<<16,D=F+J+B+L+524296,O=D+2*(J+B)>>3,H=D+2*(F+L)>>3;a&&(D=O+F>>1,F=H+J>>1,w(a[b+2*y-1],D&255,D>>16,q,r+(2*y-1)*z),w(a[b+2*y-0],F&255,F>>16,q,r+(2*y-0)*z));c&&(D=H+B>>1,F=O+L>>1,w(c[d+2*y-1],D&255,D>>16,u,v+(2*y-1)*z),w(c[d+2*y+0],F&255,F>>16,u,v+(2*y+0)*z));F=J;B=L}C&1||(a&&(D=3*F+B+131074>>2,w(a[b+C-1],D&255,D>>16,q,r+(C-1)*z)),c&&(D=3*B+F+131074>>2,w(c[d+C-1],D&255,D>>16,u,v+(C-1)*z)))}function pg(a,
b,c,d,e,g,k,h,f,l,m,t,q,r,u,v,w){ab(a,b,c,d,e,g,k,h,f,l,m,t,q,r,u,v,w,hc,3)}function qg(a,b,c,d,e,g,k,h,f,l,m,t,q,r,u,v,w){ab(a,b,c,d,e,g,k,h,f,l,m,t,q,r,u,v,w,Vc,3)}function Oe(a,b,c,d,e,g,k,h,f,l,m,t,q,r,u,v,w){ab(a,b,c,d,e,g,k,h,f,l,m,t,q,r,u,v,w,pe,4)}function Pe(a,b,c,d,e,g,k,h,f,l,m,t,q,r,u,v,w){ab(a,b,c,d,e,g,k,h,f,l,m,t,q,r,u,v,w,oe,4)}function Qe(a,b,c,d,e,g,k,h,f,l,m,t,q,r,u,v,w){ab(a,b,c,d,e,g,k,h,f,l,m,t,q,r,u,v,w,me,4)}function Re(a,b,c,d,e,g,k,h,f,l,m,t,q,r,u,v,w){ab(a,b,c,d,e,g,k,h,
f,l,m,t,q,r,u,v,w,ne,2)}function rg(a,b,c,d,e,g,k,h,f,l,m,t,q,r,u,v,w){ab(a,b,c,d,e,g,k,h,f,l,m,t,q,r,u,v,w,le,2)}function Ca(a,b,c,d,e,g,k,h,f,l,m,t,q,r,u){var v;for(v=0;v<q-1;v+=2)r(a[b+0],e[g+0],k[h+0],f,l),r(a[b+1],e[g+0],k[h+0],f,l+u),r(c[d+0],e[g+0],k[h+0],m,t),r(c[d+1],e[g+0],k[h+0],m,t+u),b+=2,d+=2,g++,h++,l+=2*u,t+=2*u;v==q-1&&(r(a[b+0],e[g+0],k[h+0],f,l),r(c[d+0],e[g+0],k[h+0],m,t))}function Se(a,b,c,d,e,g,k,f,n,l,m,t,q){Ca(a,b,c,d,e,g,k,f,n,l,m,t,q,pe,4)}function Te(a,b,c,d,e,g,k,f,n,l,
m,t,q){Ca(a,b,c,d,e,g,k,f,n,l,m,t,q,oe,4)}function Ue(a,b,c,d,e,g,k,f,n,l,m,t,q){Ca(a,b,c,d,e,g,k,f,n,l,m,t,q,me,4)}function Ve(a,b,c,d,e,g,k,f,n,l,m,t,q){Ca(a,b,c,d,e,g,k,f,n,l,m,t,q,ne,2)}function sg(a,b,c,d,e,g){for(;0<e--;){for(var k=a,f=b+(c?1:0),n=a,l=b+(c?0:3),m=s,m=0;m<d;++m){var t=n[l+4*m];if(255!=t){var t=32897*t,q=k,r=f+4*m+0;k[f+4*m+0]*t>>>23;q[r]=ca;q=k;r=f+4*m+1;k[f+4*m+1]*t>>>23;q[r]=ca;q=k;r=f+4*m+2;k[f+4*m+2]*t>>>23;q[r]=ca}}b+=g}}function tg(a,b){var c=b.j.c.Va,d=c.y,e=c.D+a.w*c.F,
g=c.c,k=c.B+(a.w>>1)*c.nb,f=c.S,n=c.C+(a.w>>1)*c.rb,l=a.m,m=a.h,t=parseInt((l+1)/2,10),q=parseInt((m+1)/2,10),r;for(r=0;r<m;++r)N(d,e+r*c.F,a.y,a.D+r*a.F,l);for(r=0;r<q;++r)N(g,k+r*c.nb,a.c,a.B+r*a.Da,t),N(f,n+r*c.rb,a.S,a.C+r*a.Da,t);return a.h}function ug(a,b){var c=b.j,d=c.c.RGBA,e=d.ma,g=d.Sa+a.w*d.f,k=a.y,f=a.D,n=a.c,l=a.B,m=a.S,t=a.C,c=vg[c.J],q=a.m,r=a.h-1,u;for(u=0;u<r;u+=2)c(k,f,k,f+a.F,n,l,m,t,e,g,e,g+d.f,q),f+=2*a.F,l+=a.Da,t+=a.Da,g+=2*d.f;u==r&&c(k,f,k,f,n,l,m,t,e,g,e,g,q);return a.h}
function wg(a,b){var c=a.h,d=b.j.c.RGBA,e=d.ma,g=d.Sa+a.w*d.f,k=V[b.j.J],f=a.y,n=a.D,l=a.c,m=a.B,t=a.S,q=a.C,r=b.Qb,u=b.Rb,v=b.lc,w=b.mc,A=a.w,z=a.w+a.h,y=a.m,D=parseInt((y+1)/2,10);0==A?k(p,p,f,n,l,m,t,q,l,m,t,q,p,p,e,g,y):(k(b.Sb,b.Tb,f,n,r,u,v,w,l,m,t,q,e,g-d.f,e,g,y),++c);for(;A+2<z;A+=2)r=l,u=m,v=t,w=q,m+=a.Da,q+=a.Da,g+=2*d.f,n+=2*a.F,k(f,n-a.F,f,n,r,u,v,w,l,m,t,q,e,g-d.f,e,g,y);n+=a.F;a.k+z<a.K?(N(b.Sb,b.Tb,f,n,1*y),N(b.Qb,b.Rb,l,m,1*D),N(b.lc,b.mc,t,q,1*D),c--):z&1||k(f,n,p,p,l,m,t,q,l,m,
t,q,e,g+d.f,p,p,y);return c}function xg(a,b){var c=a.p,d=a.q,e=b.j.c.Va,g=a.m,f=a.h,h=e.p,n=e.q+a.w*e.Fa,c=a.p,d=a.q,l=s;if(c!=p)for(l=0;l<f;++l)N(h,n,c,d,1*g),d+=a.width,n+=e.Fa;else if(e.p!=p)for(l=0;l<f;++l)jd(h,n,255,g),n+=e.Fa;return 0}function We(a,b,c){var d=a.w;c[0]=a.h;a.Bb&&(0==d?--c[0]:(--d,b[0]-=a.width),a.k+a.w+a.h==a.K&&(c[0]=a.K-a.k-d));return d}function yg(a,b){var c=a.p,d=[a.q];if(c!=p){for(var e=a.m,g=b.j.J,f=g==Ab||g==Bb,h=b.j.c.RGBA,n=[s],l=We(a,d,n),d=d[0],m=h.ma,l=h.Sa+l*h.f,
t=l+(f?0:3),q=255,r=s,u=s,u=0;u<n[0];++u){for(r=0;r<e;++r){var v=c[d+r];m[t+4*r]=v;q&=v}d+=a.width;t+=h.f}255!=q&&F(g)&&WebPApplyAlphaMultiply(m,l,f,e,n,h.f)}return 0}function zg(a,b){var c=a.p,d=[a.q];if(c!=p){var e=a.m,g=b.j.J,f=b.j.c.RGBA,h=[s],n=We(a,d,h),d=d[0],l=f.ma,n=f.Sa+n*f.f,m=n+1,t=15,q=s;for(j=0;j<h[0];++j){for(q=0;q<e;++q){var r=c[d+q]>>4;l[m+2*q]=l[m+2*q]&240|r;t&=r}d+=a.width;m+=f.f}15!=t&&F(g)&&WebPApplyAlphaMultiply4444(l,n,e,h,f.f)}return 0}function vd(a){var b=a.ka,c=b.j.J,d=c<
ua,e=c==jb||c==Pa||c==Ab||c==kb||c==Ra||F(c);b.memory=p;b.$a=p;b.zb=p;b.ad=p;if(!Ne(b.Qa,a,e?ua:Ra))return 0;if(a.I){if(!(d?InitRGBRescaler(a,b):InitYUVRescaler(a,b)))return alert("memory error #1"),0}else{if(d){if(b.$a=ug,a.Bb){var g=a.m+1>>1,f=a.m+2*g,h,n=[];for(h=0;h<f;++h)n.push(205);n.push(0);b.memory=n;if(b.memory==p)return alert("memory error #2"),0;b.Sb=b.memory;b.Tb=0;b.Qb=b.Sb;b.Rb=b.Tb+a.m;b.lc=b.Qb;b.mc=b.Rb+g;b.$a=wg;V[Qa]=pg;V[jb]=Oe;V[Zc]=qg;V[Pa]=Pe;V[Ab]=Qe;V[kb]=Re;V[Fe]=rg}}else b.$a=
tg;e&&(F(c)&&(WebPApplyAlphaMultiply=sg,V[Ob]=Oe,V[Pb]=Pe,V[Bb]=Qe,V[Qb]=Re),b.zb=c==kb||c==Qb?zg:d?yg:xg)}if(d&&!Xe){for(a=0;256>a;++a)Za[a]=89858*(a-128)+Jb>>ea,wb[a]=-22014*(a-128)+Jb,vb[a]=-45773*(a-128),xb[a]=113618*(a-128)+Jb>>ea;for(a=J;a<dd;++a)b=76283*(a-16)+Jb>>ea,ia[a-J]=wa(b,255),Hb[a-J]=wa(b+8>>4,15);Xe=1}return 1}function ud(a){var b=a.ka,c=a.m,d=a.h;$(!(a.w&1));if(0>=c||0>=d)return 0;c=b.$a(a,b);b.ec+=c;b.zb&&b.zb(a,b);return 1}function wd(a){a=a.ka;a.memory="";a.memory=p}function ed(a,
b){return a[b+0]|a[b+1]<<8|a[b+2]<<16}function Kb(a,b){return(ed(a,b)|a[b+3]<<24)>>>0}function Ye(a,b,c,d,e,g,f){var h=0,n=[0],l="VP8StatusCode",m=M(Gc);if(a==p||c[0]<Lb)return Z;m.data=a;m.b=[b[0]];m.e=[c[0]];m.na=[m.na];a:{h=m.na;$(a!=p);$(c!=p);$(h!=p);h[0]=0;if(c[0]>=Lb&&!kd(a,b[0],"RIFF",O)){if(kd(a,b[0]+8,"WEBP",O)){l=W;break a}var t=Kb(a,b[0]+O);if(t<O+R){l=W;break a}h[0]=t;b[0]+=Lb;c[0]-=Lb}else h[0]=0;l=L}m.na=m.na[0];if(l!=L)return l;h=0<m.na;t=[0];a:if(l=R+fd,$(a!=p),$(c!=p),$(n!=p),n[0]=
0,c[0]<R)l=Z;else{if(!kd(a,b[0],"VP8X",O)){var q=s,r=s,u=E;if(Kb(a,b[0]+O)!=fd){l=W;break a}if(c[0]<l){l=Z;break a}u=Kb(a,b[0]+8);q=1+ed(a,b[0]+12);r=1+ed(a,b[0]+15);if(q*r>=Ag){l=W;break a}t!=p&&(t[0]=u);d!=p&&(d[0]=q);e!=p&&(e[0]=r);b[0]+=l;c[0]-=l;n[0]=1}l=L}if(l!=L)return l;if(!h&&n[0])return W;g!=p&&(g[0]=!!(t[0]&Bg));if(n&&f==p)return L;if(c<O)return Z;if(h&&n[0]||!h&&!n[0]&&!kd(a,b[0],"ALPH",O)){m.$=[m.$];m.G=[m.G];m.pa=[m.pa];a:{var n=m.na,h=m.$,t=m.G,l=m.pa,q=x,r=0,u=Mb,v=O+R+fd;$(a!=p);
$(c!=p);q=a;r=b[0];u=c[0];$(h!=p);$(l!=p);h[0]=p;t[0]=p;for(l[0]=0;;){var w=E,y=E;b[0]=r;c[0]=u;if(u<R){l=Z;break a}w=Kb(q,r+O);y=R+w+1&-2;v+=y;if(0<n&&v>n){l=W;break a}if(u<y){l=Z;break a}if(kd(q,r,"ALPH",O)){if(!kd(q,r,"VP8 ",O)||!kd(q,"VP8L",O)){l=L;break a}}else h[0]=q,t[0]=r+R,l[0]=w;r+=y;u-=y}l=ca}m.$=m.$[0];m.G=m.G[0];m.pa=m.pa[0];if(l!=L)return l}m.ta=[m.ta];m.ia=[m.ia];a:if(n=m.na,h=m.ta,t=m.ia,r=!kd(a,b[0],"VP8 ",O),l=!kd(a,b[0],"VP8L",O),q=O+R,$(a!=p),$(c!=p),$(h!=p),$(t!=p),c[0]<R)l=Z;
else{if(r||l){r=Kb(a,b[0]+O);if(n>=q&&r>n-q){l=W;break a}h[0]=r;b[0]+=R;c[0]-=R;t[0]=l}else t[0]=1<=c&&a[b+0]==ve,h[0]=c[0];l=L}m.ta=m.ta[0];m.ia=m.ia[0];if(l!=L)return l;if(m.ta>Ze)return W;if(m.ia){if(c[0]<$e)return Z;n=b[0];h=c[0];d=d?d[0]:p;e=e?e[0]:p;t=g?g[0]:p;a==p||h<$e?a=0:(l=[s],q=[s],r=[s],u=M(af),Rb(u,a,n,h),ue(u,l,q,r)?(d!=p&&(d[0]=l[0]),e!=p&&(e[0]=q[0]),t!=p&&(t[0]=r[0]),a=1):a=0)}else{if(c<bf)return Z;n=b[0];h=c[0];d=d?d[0]:p;e=e?e[0]:p;!(a==p||h<bf)&&3<=h-3&&157==a[n+3+0]&&1==a[n+
3+1]&&42==a[n+3+2]?(h=a[n+0]|a[n+1]<<8|a[n+2]<<16,t=(a[n+7]<<8|a[n+6])&16383,a=(a[n+9]<<8|a[n+8])&16383,!(!(h&1)+0)||3<(h>>1&7)||!(h>>4&1)||h>>5>=m.ta?a=0:(d&&(d[0]=t),e&&(e[0]=a),a=1)):a=0}if(!a)return W;g!=p&&(g[0]|=m.$!=p);f!=p&&(f[0]=m,f[0].offset=b[0]-f[0].b,$(b[0]-f[0].b<Ze),$(f[0].offset==f[0].e-c[0]));return L}function Kd(a){$(a!=p);return Ye(a[0].data,a[0].b,a[0].e,p,p,p,a)}function cf(a,b,c,d){var e="VP8StatusCode",g=M(Vb),f=M(Gc);f.data=a;f.b=b;f.e=c;f.b=[f.b];f.e=[f.e];f=[f];e=Kd(f);if(e!=
L)return e;f=f[0];f.b=f.b[0];f.e=f.e[0];$(d!=p);td(na);g.data=f.data;g.b=b+f.offset;g.e=f.e-f.offset;g.put=ud;g.Mb=vd;g.Pb=wd;g.ka=d;if(f.ia){a=sd();if(a==p)return cb;ng(a,g)?(e=zd(g.width,g.height,d.Qa,d.j),e==L&&!og(a)&&(e=a.a)):e=a.a;a!=p&&sa(a)}else{e=M(Cg);e!=p&&(Gd(e),e.za=0,e.Hb=1);a=e;if(a==p)return cb;a.qb=0;a.Ga=f.$;a.G=f.G;a.ub=f.pa;Hd(a,g)?(e=zd(g.width,g.height,d.Qa,d.j),e==L&&!Mf(a,g)&&(e=a.a)):e=a.a;a!=p&&ke(a)}e!=L&&this.Yc(d.j);return e}function lb(a,b,c,d,e){var g={value:0};c={value:c};
var f=M(df),h=M(gd);f.j=h;h.J=a;var n={value:h.width},l={value:h.height},m;m=c;var t=M(ef);hd(b,g,m,t)!=L?m=0:(n!=p&&(n.value=t.width),l!=p&&(l.value=t.height),m=1);if(!m)return p;h.width=n.value;h.height=l.value;d!=p&&(d.value=h.width.value);e!=p&&(e.value=h.height.value);return cf(b,g.value,c.value,f)!=L?p:a<ua?h.c.RGBA.ma:h.c.Va.y}function hd(a,b,c,d){if(d==p||a==p)return ta;$(d!=p);d.tc=0;d.width=[d.width];d.height=[d.height];d.$b=[d.$b];return Ye(a,b,c,d.width,d.height,d.$b,p)}function Ne(a,
b,c){var d=b.width,e=b.height,g=0,f=0,h=d,n=e;b.Ua=a!=p&&0<a.Ua;if(b.Ua&&(h=a.wc,n=a.vc,g=a.t,f=a.k,c<ua||(g&=-2,f&=-2),0>g||0>f||0>=h||0>=n||g+h>d||f+n>e))return 0;b.t=g;b.k=f;b.Ka=g+h;b.K=f+n;b.m=h;b.h=n;b.I=a!=p&&0<a.I;if(b.I){if(0>=a.Ba||0>=a.Aa)return 0;b.Ba=a.Ba;b.Aa=a.Aa}b.Za=a&&a.Za;b.Bb=a==p||!a.ed;b.I&&(b.Za=b.Ba<3*d/4&&b.Aa<3*e/4,b.Bb=0);return 1}var na=512,Qa=0,jb=1,Zc=2,Pa=3,Ab=4,kb=5,Fe=6,Ob=7,Pb=8,Bb=9,Qb=10,ua=11,Ra=12,Cc=13;this.WEBP_CSP_MODE=this.Cd={nd:0,od:1,kd:2,ld:3,jd:4,pd:5,
qd:6,rd:7,sd:8,md:9};var gd={J:"WEBP_CSP_MODE",width:s,height:s,Fc:s,c:{RGBA:{ma:x,Sa:0,f:s,size:Mb},Va:{y:x,c:x,S:x,p:x,D:x,B:x,C:x,q:x,F:s,nb:s,rb:s,Fa:s,Wc:Mb,Rc:Mb,Uc:Mb,Wb:Mb}},Ic:U(4,E),Jb:p,jc:x},L=0,cb=1,ta=2,W=3,Hf=4,Ie=5,Nf=6,Z=7;this.VP8StatusCode=this.td={xd:0,yd:1,vd:2,ud:3,Ad:4,zd:5,Bd:6,wd:7};var ef={width:{value:s},height:{value:s},$b:{value:s},tc:s,Yd:s,rotate:s,be:s,Ic:U(3,E)};this.WebPGetFeatures=this.Md=function(a,b,c){var d="VP8StatusCode";na>>>8!=na>>>8||c==p?a=ta:(b=[b],d=hd(a,
[0],b,c),a=d==Z?W:d);return a};var ff={Za:s,ed:s,Ua:s,t:s,k:s,wc:s,vc:s,I:s,Ba:s,Aa:s,ae:s,Td:s,Xd:s,Ic:U(6,E)};this.WebPDecoderConfig=this.Kd={input:M(ef),j:M(gd),options:M(ff)};this.WebPInitDecoderConfig=this.Nd=function(a){na>>>8!=na>>>8||a==p?a=0:(a=a.input,$(a!=p),a.tc=0,a=1);return a};var Vb={width:s,height:s,w:s,m:s,h:s,y:x,c:x,S:x,D:0,B:0,C:0,F:s,Da:s,ka:0,put:0,Mb:0,Pb:0,Bb:s,e:Mb,data:x,b:0,Za:s,Ua:s,t:s,Ka:s,k:s,K:s,I:s,Ba:s,Aa:s,p:x,q:0},df={j:M(gd),Sb:x,Qb:x,lc:x,Tb:0,Rb:0,mc:0,ec:s,
Qa:M(ff),memory:0,$a:"(OutputFunc)",zb:"(OutputFunc)",ad:"(OutputRowFunc)"},Gc={data:x,b:x,e:Mb,offset:Mb,$:p,G:x,pa:Mb,ta:Mb,na:Mb,ia:s},Fc={qa:x,Ia:p,Pd:x,Ab:s,la:E,Z:E,gc:s},af={T:bb,qa:x,Ia:x,ya:Mb,Q:Mb,g:s,L:s,fa:s},gf=25,hf=[0,1,3,7,15,31,63,127,255,511,1023,2047,4095,8191,16383,32767,65535,131071,262143,524287,1048575,2097151,4194303,8388607,16777215],bf=10,ve=47,we=14,Wf=3,$e=5,fg=11,Yc=5,qe=4278190080,jg=8,Tb=15,Ba=256,Ge=24,Je=4,Be=0,De=1,Ae=2,Ee=3,Ub=1,kc=0,kf=1,rd=1,O=4,R=8,Lb=12,fd=10,
Bg=16,Ag=1*Math.pow(2,32),Ze=-1-R-1>>>0,jf={kc:s,s:s},Le={Y:"HuffmanTreeNode*",gb:s,Pa:s},pd=-1,Dg={ea:E,bb:s},ad=506832829,$b=0,ge=$b,fe=2,ee=3,de=1,Ef=4,Df=5,Cf=6,Ld=3,xa=4,Hc=4,Gf=4,Md=4,Nd=8,Kc=3,Lc=11,f=32,Pf=17*f+9*f,Tc=1*f+8,Uc=Tc+16*f+f,he=Uc+16,Id={fb:x,Jc:x,Nc:x,Ra:E},Jd={l:0,v:0,gd:x,hd:x,uc:x,$c:x},Eg={pb:s,ob:s,tb:s,Kb:U(xa,0),Cb:U(xa,0)},Fg={Ta:U(Ld,x),z:md([Md,Nd,Kc,Lc],x)},Gg={Oc:s,Fb:s,kb:s,oc:s,Lc:U(Hc,s),Gc:U(Hc,s)},Oc={zc:s,yc:s,ab:s},Qd={X:s,ua:s,Nb:s},id=U(2,s),Hg={sc:M(id),
sb:M(id),qc:M(id)},Ig={ha:s,d:s,W:s,M:Oc,N:Vb},Cg={a:"VP8StatusCode",za:s,xc:0,o:M(Fc),Ac:M(Id),P:M(Jd),ga:M(Gg),Ca:M(Eg),rc:"WebPWorker",qb:s,Ja:s,jb:s,oa:Ig,Ma:s,hb:s,lb:s,mb:s,wb:s,Ya:s,Hb:s,ic:ld(8,Fc),Zc:E,yb:ld(xa,Hg),R:M(Fg),pc:s,Pc:x,dc:x,cc:U(4,x),Xc:x,Sc:x,Vc:x,La:M(Qd),M:M(Oc),Ea:x,z:0,ca:x,aa:x,ra:x,da:s,ba:s,sa:s,H:s,r:s,ib:0,Gb:Mb,i:s,d:s,wa:x,Eb:U(16,x),Vd:0,Tc:x,Lb:x,ja:E,Oa:E,A:s,W:s,Zb:U(xa,x),Ga:p,G:0,ub:Mb,Xb:x,Od:0,cd:s,dd:x,Wd:0,fc:Mb},Db=0,Cb=1,cd=2,Jg={Qc:"VP8LImageTransformType",
n:s,U:s,Vb:s,u:E,b:E},gg={va:ld(Yc,Le)},Kg={xb:s,Yb:M(Dg),Dc:s,eb:s,Ec:s,ac:E,bd:E,hc:s,Db:"HTreeGroup"},eg={a:"VP8StatusCode",Wa:"VP8LDecodeState",Ob:"VP8LDecodeState",N:"VP8Io",Ib:"WebPDecBuffer",Hc:"WebPDecBuffer",V:E,Ha:E,Xa:E,vb:E,o:M(af),l:s,v:s,O:s,xa:s,cb:M(Kg),Na:s,nc:ld(Je,Jg),Ub:E,Mc:x,$d:x,Zd:"*WebPRescaler"},lf=4,nf=[p,function(a,b,c,d,e,g,f,h){var n=s,l=h;$(a!=p);$(f!=p);$(0<c);$(0<d);$(0<e);$(g>=c*e);for(n=0;n<d;++n)0==n?N(f,h,a,b,e):Ea(a,b,f,l-g,f,h,e),Ea(a,b+e,f,l,f,h+e,e*(c-1)),
l+=g,b+=g,h+=g},function(a,b,c,d,e,f,k,h){var n=s,l=h;$(a!=p);$(k!=p);$(0<c);$(0<d);$(0<e);$(f>=c*e);N(k,h,a,b,e);Ea(a,b+e,k,l,k,h+e,e*(c-1));for(n=1;n<d;++n)b+=f,h+=f,Ea(a,b,k,l,k,h,e*c),l+=f},function(a,b,c,d,e,f,k,h){var n=h,l=s;$(a!=p);$(k!=p);$(0<c);$(0<d);$(0<e);$(f>=c*e);N(k,h,a,b,e);Ea(a,b+e,k,n,k,h+e,e*(c-1));for(l=1;l<d;++l){var m=s,n=n+f;b+=f;h+=f;Ea(a,b,k,n-f,k,h,e);for(m=e;m<c*e;++m){var t=k[n+m-e]+k[n+m-f]-k[n+m-f-e];k[h+m]=a[b+m]+(0>t?0:255<t?255:t)&255}}}],yd=[3,4,3,4,4,2,2,4,4,4,
2,1,1];this.WebPFreeDecBuffer=this.Yc=function(a){a!=p&&(a.Fc||(a.Jb=""),a.jc=0,a.Jb=a.jc=p)};var va=U(511,x),tc=U(511,x),sc=U(2041,0),oc=U(225,0),oa=U(766,x),Rd=0,Xb=85627,Wb=35468,Uf=[function(a,b){var c=4,d;for(d=0;4>d;++d)c+=a[b+d-f]+a[b-1+d*f];c>>=3;for(d=0;4>d;++d)jd(a,b+d*f,c,4)},function(a,b){Dc(a,b,4)},function(a,b){var c=b-f,d=[];d.push(y(a[c-1],a[c+0],a[c+1]));d.push(y(a[c+0],a[c+1],a[c+2]));d.push(y(a[c+1],a[c+2],a[c+3]));d.push(y(a[c+2],a[c+3],a[c+4]));for(c=0;4>c;++c)N(a,b+c*f,d,0,4)},
function(a,b){var c=a[b-1],d=a[b-1+f],e=a[b-1+2*f],g=a[b-1+3*f];a[b+0+0*f]=a[b+1+0*f]=a[b+2+0*f]=a[b+3+0*f]=y(a[b-1-f],c,d);a[b+0+1*f]=a[b+1+1*f]=a[b+2+1*f]=a[b+3+1*f]=y(c,d,e);a[b+0+2*f]=a[b+1+2*f]=a[b+2+2*f]=a[b+3+2*f]=y(d,e,g);a[b+0+3*f]=a[b+1+3*f]=a[b+2+3*f]=a[b+3+3*f]=y(e,g,g)},function(a,b){var c=a[b-1+0*f],d=a[b-1+1*f],e=a[b-1+2*f],g=a[b-1-f],k=a[b+0-f],h=a[b+1-f],n=a[b+2-f],l=a[b+3-f];a[b+0+3*f]=y(d,e,a[b-1+3*f]);a[b+0+2*f]=a[b+1+3*f]=y(c,d,e);a[b+0+1*f]=a[b+1+2*f]=a[b+2+3*f]=y(g,c,d);a[b+
0+0*f]=a[b+1+1*f]=a[b+2+2*f]=a[b+3+3*f]=y(k,g,c);a[b+1+0*f]=a[b+2+1*f]=a[b+3+2*f]=y(h,k,g);a[b+2+0*f]=a[b+3+1*f]=y(n,h,k);a[b+3+0*f]=y(l,n,h)},function(a,b){var c=a[b-1+0*f],d=a[b-1+1*f],e=a[b-1+2*f],g=a[b-1-f],k=a[b+0-f],h=a[b+1-f],n=a[b+2-f],l=a[b+3-f];a[b+0+0*f]=a[b+1+2*f]=g+k+1>>1;a[b+1+0*f]=a[b+2+2*f]=k+h+1>>1;a[b+2+0*f]=a[b+3+2*f]=h+n+1>>1;a[b+3+0*f]=n+l+1>>1;a[b+0+3*f]=y(e,d,c);a[b+0+2*f]=y(d,c,g);a[b+0+1*f]=a[b+1+3*f]=y(c,g,k);a[b+1+1*f]=a[b+2+3*f]=y(g,k,h);a[b+2+1*f]=a[b+3+3*f]=y(k,h,n);
a[b+3+1*f]=y(h,n,l)},function(a,b){var c=a[b+1-f],d=a[b+2-f],e=a[b+3-f],g=a[b+4-f],k=a[b+5-f],h=a[b+6-f],n=a[b+7-f];a[b+0+0*f]=y(a[b+0-f],c,d);a[b+1+0*f]=a[b+0+1*f]=y(c,d,e);a[b+2+0*f]=a[b+1+1*f]=a[b+0+2*f]=y(d,e,g);a[b+3+0*f]=a[b+2+1*f]=a[b+1+2*f]=a[b+0+3*f]=y(e,g,k);a[b+3+1*f]=a[b+2+2*f]=a[b+1+3*f]=y(g,k,h);a[b+3+2*f]=a[b+2+3*f]=y(k,h,n);a[b+3+3*f]=y(h,n,n)},function(a,b){var c=a[b+0-f],d=a[b+1-f],e=a[b+2-f],g=a[b+3-f],k=a[b+4-f],h=a[b+5-f],n=a[b+6-f],l=a[b+7-f];a[b+0+0*f]=c+d+1>>1;a[b+1+0*f]=a[b+
0+2*f]=d+e+1>>1;a[b+2+0*f]=a[b+1+2*f]=e+g+1>>1;a[b+3+0*f]=a[b+2+2*f]=g+k+1>>1;a[b+0+1*f]=y(c,d,e);a[b+1+1*f]=a[b+0+3*f]=y(d,e,g);a[b+2+1*f]=a[b+1+3*f]=y(e,g,k);a[b+3+1*f]=a[b+2+3*f]=y(g,k,h);a[b+3+2*f]=y(k,h,n);a[b+3+3*f]=y(h,n,l)},function(a,b){var c=a[b-1+0*f],d=a[b-1+1*f],e=a[b-1+2*f],g=a[b-1+3*f],k=a[b-1-f],h=a[b+0-f],n=a[b+1-f],l=a[b+2-f];a[b+0+0*f]=a[b+2+1*f]=c+k+1>>1;a[b+0+1*f]=a[b+2+2*f]=d+c+1>>1;a[b+0+2*f]=a[b+2+3*f]=e+d+1>>1;a[b+0+3*f]=g+e+1>>1;a[b+3+0*f]=y(h,n,l);a[b+2+0*f]=y(k,h,n);a[b+
1+0*f]=a[b+3+1*f]=y(c,k,h);a[b+1+1*f]=a[b+3+2*f]=y(d,c,k);a[b+1+2*f]=a[b+3+3*f]=y(e,d,c);a[b+1+3*f]=y(g,e,d)},function(a,b){var c=a[b-1+0*f],d=a[b-1+1*f],e=a[b-1+2*f],g=a[b-1+3*f];a[b+0+0*f]=c+d+1>>1;a[b+2+0*f]=a[b+0+1*f]=d+e+1>>1;a[b+2+1*f]=a[b+0+2*f]=e+g+1>>1;a[b+1+0*f]=y(c,d,e);a[b+3+0*f]=a[b+1+1*f]=y(d,e,g);a[b+3+1*f]=a[b+1+2*f]=y(e,g,g);a[b+3+2*f]=a[b+2+2*f]=a[b+0+3*f]=a[b+1+3*f]=a[b+2+3*f]=a[b+3+3*f]=g}],Vf=[function(a,b){var c=16,d;for(d=0;16>d;++d)c+=a[b-1+d*f]+a[b+d-f];Yb(c>>5,a,b)},function(a,
b){Dc(a,b,16)},function(a,b){var c;for(c=0;16>c;++c)N(a,b+c*f,a,b-f,16)},function(a,b){var c;for(c=16;0<c;--c)jd(a,b+0,a[b-1],16),b+=f},function(a,b){var c=8,d;for(d=0;16>d;++d)c+=a[b-1+d*f];Yb(c>>4,a,b)},function(a,b){var c=8,d;for(d=0;16>d;++d)c+=a[b+d-f];Yb(c>>4,a,b)},function(a,b){Yb(128,a,b)}],je=[function(a,b){var c=8,d;for(d=0;8>d;++d)c+=a[b+d-f]+a[b-1+d*f];Zb(1*(c>>4),a,b)},function(a,b){Dc(a,b,8)},function(a,b){var c;for(c=0;8>c;++c)N(a,b+c*f,a,b-f,8)},function(a,b){var c;for(c=0;8>c;++c)jd(a,
b+0,a[b-1],8),b+=f},function(a,b){var c=4,d;for(d=0;8>d;++d)c+=a[b-1+d*f];Zb(1*(c>>3),a,b)},function(a,b){var c=4,d;for(d=0;8>d;++d)c+=a[b+d-f];Zb(1*(c>>3),a,b)},function(a,b){Zb(128,a,b)}],mc,Pc,Qc,Rc,Sd,Td,Ud,Vd,Wd,Xd,Yd,Zd,$d,ae,be,ce,Pd=31,uc=[0,2,8],Od=3,Of=1,ie=[0+0*f,4+0*f,8+0*f,12+0*f,0+4*f,4+4*f,8+4*f,12+4*f,0+8*f,4+8*f,8+8*f,12+8*f,0+12*f,4+12*f,8+12*f,12+12*f],Ic=[4,5,6,7,8,9,10,10,11,12,13,14,15,16,17,17,18,19,20,20,21,21,22,22,23,23,24,25,25,26,27,28,29,30,31,32,33,34,35,36,37,37,38,
39,40,41,42,43,44,45,46,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,76,77,78,79,80,81,82,83,84,85,86,87,88,89,91,93,95,96,98,100,101,102,104,106,108,110,112,114,116,118,122,124,126,128,130,132,134,136,138,140,143,145,148,151,154,157],Jc=[4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,60,62,64,66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96,
98,100,102,104,106,108,110,112,114,116,119,122,125,128,131,134,137,140,143,146,149,152,155,158,161,164,167,170,173,177,181,185,189,193,197,201,205,209,213,217,221,225,229,234,239,245,249,254,259,264,269,274,279,284],Sf=[-$b,1,-1,2,-2,3,4,6,-3,5,-4,-5,-6,7,-7,8,-8,-9],Ff=[[[[128,128,128,128,128,128,128,128,128,128,128],[128,128,128,128,128,128,128,128,128,128,128],[128,128,128,128,128,128,128,128,128,128,128]],[[253,136,254,255,228,219,128,128,128,128,128],[189,129,242,255,227,213,255,219,128,128,
128],[106,126,227,252,214,209,255,255,128,128,128]],[[1,98,248,255,236,226,255,255,128,128,128],[181,133,238,254,221,234,255,154,128,128,128],[78,134,202,247,198,180,255,219,128,128,128]],[[1,185,249,255,243,255,128,128,128,128,128],[184,150,247,255,236,224,128,128,128,128,128],[77,110,216,255,236,230,128,128,128,128,128]],[[1,101,251,255,241,255,128,128,128,128,128],[170,139,241,252,236,209,255,255,128,128,128],[37,116,196,243,228,255,255,255,128,128,128]],[[1,204,254,255,245,255,128,128,128,128,
128],[207,160,250,255,238,128,128,128,128,128,128],[102,103,231,255,211,171,128,128,128,128,128]],[[1,152,252,255,240,255,128,128,128,128,128],[177,135,243,255,234,225,128,128,128,128,128],[80,129,211,255,194,224,128,128,128,128,128]],[[1,1,255,128,128,128,128,128,128,128,128],[246,1,255,128,128,128,128,128,128,128,128],[255,128,128,128,128,128,128,128,128,128,128]]],[[[198,35,237,223,193,187,162,160,145,155,62],[131,45,198,221,172,176,220,157,252,221,1],[68,47,146,208,149,167,221,162,255,223,128]],
[[1,149,241,255,221,224,255,255,128,128,128],[184,141,234,253,222,220,255,199,128,128,128],[81,99,181,242,176,190,249,202,255,255,128]],[[1,129,232,253,214,197,242,196,255,255,128],[99,121,210,250,201,198,255,202,128,128,128],[23,91,163,242,170,187,247,210,255,255,128]],[[1,200,246,255,234,255,128,128,128,128,128],[109,178,241,255,231,245,255,255,128,128,128],[44,130,201,253,205,192,255,255,128,128,128]],[[1,132,239,251,219,209,255,165,128,128,128],[94,136,225,251,218,190,255,255,128,128,128],[22,
100,174,245,186,161,255,199,128,128,128]],[[1,182,249,255,232,235,128,128,128,128,128],[124,143,241,255,227,234,128,128,128,128,128],[35,77,181,251,193,211,255,205,128,128,128]],[[1,157,247,255,236,231,255,255,128,128,128],[121,141,235,255,225,227,255,255,128,128,128],[45,99,188,251,195,217,255,224,128,128,128]],[[1,1,251,255,213,255,128,128,128,128,128],[203,1,248,255,255,128,128,128,128,128,128],[137,1,177,255,224,255,128,128,128,128,128]]],[[[253,9,248,251,207,208,255,192,128,128,128],[175,13,
224,243,193,185,249,198,255,255,128],[73,17,171,221,161,179,236,167,255,234,128]],[[1,95,247,253,212,183,255,255,128,128,128],[239,90,244,250,211,209,255,255,128,128,128],[155,77,195,248,188,195,255,255,128,128,128]],[[1,24,239,251,218,219,255,205,128,128,128],[201,51,219,255,196,186,128,128,128,128,128],[69,46,190,239,201,218,255,228,128,128,128]],[[1,191,251,255,255,128,128,128,128,128,128],[223,165,249,255,213,255,128,128,128,128,128],[141,124,248,255,255,128,128,128,128,128,128]],[[1,16,248,255,
255,128,128,128,128,128,128],[190,36,230,255,236,255,128,128,128,128,128],[149,1,255,128,128,128,128,128,128,128,128]],[[1,226,255,128,128,128,128,128,128,128,128],[247,192,255,128,128,128,128,128,128,128,128],[240,128,255,128,128,128,128,128,128,128,128]],[[1,134,252,255,255,128,128,128,128,128,128],[213,62,250,255,255,128,128,128,128,128,128],[55,93,255,128,128,128,128,128,128,128,128]],[[128,128,128,128,128,128,128,128,128,128,128],[128,128,128,128,128,128,128,128,128,128,128],[128,128,128,128,
128,128,128,128,128,128,128]]],[[[202,24,213,235,186,191,220,160,240,175,255],[126,38,182,232,169,184,228,174,255,187,128],[61,46,138,219,151,178,240,170,255,216,128]],[[1,112,230,250,199,191,247,159,255,255,128],[166,109,228,252,211,215,255,174,128,128,128],[39,77,162,232,172,180,245,178,255,255,128]],[[1,52,220,246,198,199,249,220,255,255,128],[124,74,191,243,183,193,250,221,255,255,128],[24,71,130,219,154,170,243,182,255,255,128]],[[1,182,225,249,219,240,255,224,128,128,128],[149,150,226,252,216,
205,255,171,128,128,128],[28,108,170,242,183,194,254,223,255,255,128]],[[1,81,230,252,204,203,255,192,128,128,128],[123,102,209,247,188,196,255,233,128,128,128],[20,95,153,243,164,173,255,203,128,128,128]],[[1,222,248,255,216,213,128,128,128,128,128],[168,175,246,252,235,205,255,255,128,128,128],[47,116,215,255,211,212,255,255,128,128,128]],[[1,121,236,253,212,214,255,255,128,128,128],[141,84,213,252,201,202,255,219,128,128,128],[42,80,160,240,162,185,255,205,128,128,128]],[[1,1,255,128,128,128,128,
128,128,128,128],[244,1,255,128,128,128,128,128,128,128,128],[238,1,255,128,128,128,128,128,128,128,128]]]],Rf=[[[231,120,48,89,115,113,120,152,112],[152,179,64,126,170,118,46,70,95],[175,69,143,80,85,82,72,155,103],[56,58,10,171,218,189,17,13,152],[114,26,17,163,44,195,21,10,173],[121,24,80,195,26,62,44,64,85],[144,71,10,38,171,213,144,34,26],[170,46,55,19,136,160,33,206,71],[63,20,8,114,114,208,12,9,226],[81,40,11,96,182,84,29,16,36]],[[134,183,89,137,98,101,106,165,148],[72,187,100,130,157,111,
32,75,80],[66,102,167,99,74,62,40,234,128],[41,53,9,178,241,141,26,8,107],[74,43,26,146,73,166,49,23,157],[65,38,105,160,51,52,31,115,128],[104,79,12,27,217,255,87,17,7],[87,68,71,44,114,51,15,186,23],[47,41,14,110,182,183,21,17,194],[66,45,25,102,197,189,23,18,22]],[[88,88,147,150,42,46,45,196,205],[43,97,183,117,85,38,35,179,61],[39,53,200,87,26,21,43,232,171],[56,34,51,104,114,102,29,93,77],[39,28,85,171,58,165,90,98,64],[34,22,116,206,23,34,43,166,73],[107,54,32,26,51,1,81,43,31],[68,25,106,22,
64,171,36,225,114],[34,19,21,102,132,188,16,76,124],[62,18,78,95,85,57,50,48,51]],[[193,101,35,159,215,111,89,46,111],[60,148,31,172,219,228,21,18,111],[112,113,77,85,179,255,38,120,114],[40,42,1,196,245,209,10,25,109],[88,43,29,140,166,213,37,43,154],[61,63,30,155,67,45,68,1,209],[100,80,8,43,154,1,51,26,71],[142,78,78,16,255,128,34,197,171],[41,40,5,102,211,183,4,1,221],[51,50,17,168,209,192,23,25,82]],[[138,31,36,171,27,166,38,44,229],[67,87,58,169,82,115,26,59,179],[63,59,90,180,59,166,93,73,
154],[40,40,21,116,143,209,34,39,175],[47,15,16,183,34,223,49,45,183],[46,17,33,183,6,98,15,32,183],[57,46,22,24,128,1,54,17,37],[65,32,73,115,28,128,23,128,205],[40,3,9,115,51,192,18,6,223],[87,37,9,115,59,77,64,21,47]],[[104,55,44,218,9,54,53,130,226],[64,90,70,205,40,41,23,26,57],[54,57,112,184,5,41,38,166,213],[30,34,26,133,152,116,10,32,134],[39,19,53,221,26,114,32,73,255],[31,9,65,234,2,15,1,118,73],[75,32,12,51,192,255,160,43,51],[88,31,35,67,102,85,55,186,85],[56,21,23,111,59,205,45,37,192],
[55,38,70,124,73,102,1,34,98]],[[125,98,42,88,104,85,117,175,82],[95,84,53,89,128,100,113,101,45],[75,79,123,47,51,128,81,171,1],[57,17,5,71,102,57,53,41,49],[38,33,13,121,57,73,26,1,85],[41,10,67,138,77,110,90,47,114],[115,21,2,10,102,255,166,23,6],[101,29,16,10,85,128,101,196,26],[57,18,10,102,102,213,34,20,43],[117,20,15,36,163,128,68,1,26]],[[102,61,71,37,34,53,31,243,192],[69,60,71,38,73,119,28,222,37],[68,45,128,34,1,47,11,245,171],[62,17,19,70,146,85,55,62,70],[37,43,37,154,100,163,85,160,
1],[63,9,92,136,28,64,32,201,85],[75,15,9,9,64,255,184,119,16],[86,6,28,5,64,255,25,248,1],[56,8,17,132,137,255,55,116,128],[58,15,20,82,135,57,26,121,40]],[[164,50,31,137,154,133,25,35,218],[51,103,44,131,131,123,31,6,158],[86,40,64,135,148,224,45,183,128],[22,26,17,131,240,154,14,1,209],[45,16,21,91,64,222,7,1,197],[56,21,39,155,60,138,23,102,213],[83,12,13,54,192,255,68,47,28],[85,26,85,85,128,128,32,146,171],[18,11,7,63,144,171,4,4,246],[35,27,10,146,174,171,12,26,128]],[[190,80,35,99,180,80,
126,54,45],[85,126,47,87,176,51,41,20,32],[101,75,128,139,118,146,116,128,85],[56,41,15,176,236,85,37,9,62],[71,30,17,119,118,255,17,18,138],[101,38,60,138,55,70,43,26,142],[146,36,19,30,171,255,97,27,20],[138,45,61,62,219,1,81,188,64],[32,41,20,117,151,142,20,21,163],[112,19,12,61,195,128,48,4,24]]],If=[[[[255,255,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255]],[[176,246,255,255,255,255,255,255,255,255,255],[223,241,
252,255,255,255,255,255,255,255,255],[249,253,253,255,255,255,255,255,255,255,255]],[[255,244,252,255,255,255,255,255,255,255,255],[234,254,254,255,255,255,255,255,255,255,255],[253,255,255,255,255,255,255,255,255,255,255]],[[255,246,254,255,255,255,255,255,255,255,255],[239,253,254,255,255,255,255,255,255,255,255],[254,255,254,255,255,255,255,255,255,255,255]],[[255,248,254,255,255,255,255,255,255,255,255],[251,255,254,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255]],
[[255,253,254,255,255,255,255,255,255,255,255],[251,254,254,255,255,255,255,255,255,255,255],[254,255,254,255,255,255,255,255,255,255,255]],[[255,254,253,255,254,255,255,255,255,255,255],[250,255,254,255,254,255,255,255,255,255,255],[254,255,255,255,255,255,255,255,255,255,255]],[[255,255,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255]]],[[[217,255,255,255,255,255,255,255,255,255,255],[225,252,241,253,255,255,254,255,
255,255,255],[234,250,241,250,253,255,253,254,255,255,255]],[[255,254,255,255,255,255,255,255,255,255,255],[223,254,254,255,255,255,255,255,255,255,255],[238,253,254,254,255,255,255,255,255,255,255]],[[255,248,254,255,255,255,255,255,255,255,255],[249,254,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255]],[[255,253,255,255,255,255,255,255,255,255,255],[247,254,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255]],[[255,253,254,255,255,
255,255,255,255,255,255],[252,255,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255]],[[255,254,254,255,255,255,255,255,255,255,255],[253,255,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255]],[[255,254,253,255,255,255,255,255,255,255,255],[250,255,255,255,255,255,255,255,255,255,255],[254,255,255,255,255,255,255,255,255,255,255]],[[255,255,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255],[255,255,255,
255,255,255,255,255,255,255,255]]],[[[186,251,250,255,255,255,255,255,255,255,255],[234,251,244,254,255,255,255,255,255,255,255],[251,251,243,253,254,255,254,255,255,255,255]],[[255,253,254,255,255,255,255,255,255,255,255],[236,253,254,255,255,255,255,255,255,255,255],[251,253,253,254,254,255,255,255,255,255,255]],[[255,254,254,255,255,255,255,255,255,255,255],[254,254,254,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255]],[[255,254,255,255,255,255,255,255,255,255,255],
[254,254,255,255,255,255,255,255,255,255,255],[254,255,255,255,255,255,255,255,255,255,255]],[[255,255,255,255,255,255,255,255,255,255,255],[254,255,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255]],[[255,255,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255]],[[255,255,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,
255,255]],[[255,255,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255]]],[[[248,255,255,255,255,255,255,255,255,255,255],[250,254,252,254,255,255,255,255,255,255,255],[248,254,249,253,255,255,255,255,255,255,255]],[[255,253,253,255,255,255,255,255,255,255,255],[246,253,253,255,255,255,255,255,255,255,255],[252,254,251,254,254,255,255,255,255,255,255]],[[255,254,252,255,255,255,255,255,255,255,255],[248,254,253,255,255,255,
255,255,255,255,255],[253,255,254,254,255,255,255,255,255,255,255]],[[255,251,254,255,255,255,255,255,255,255,255],[245,251,254,255,255,255,255,255,255,255,255],[253,253,254,255,255,255,255,255,255,255,255]],[[255,251,253,255,255,255,255,255,255,255,255],[252,253,254,255,255,255,255,255,255,255,255],[255,254,255,255,255,255,255,255,255,255,255]],[[255,252,255,255,255,255,255,255,255,255,255],[249,255,254,255,255,255,255,255,255,255,255],[255,255,254,255,255,255,255,255,255,255,255]],[[255,255,253,
255,255,255,255,255,255,255,255],[250,255,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255]],[[255,255,255,255,255,255,255,255,255,255,255],[254,255,255,255,255,255,255,255,255,255,255],[255,255,255,255,255,255,255,255,255,255,255]]]];this.WebPGetDecoderVersion=this.Ld=function(){return 512};var Nc=[0,1,2,3,6,4,5,6,6,6,6,6,6,6,6,7,0],Jf=[[173,148,140,0],[176,155,140,135,0],[180,157,141,134,130,0],[254,254,243,230,196,177,153,140,133,130,129,0]],Kf=[0,1,4,8,5,2,3,6,
9,12,13,10,7,11,14,15],Tf=md([Kc,Lc],"");U(4,x);var vc=[[0,0,0,0],[1,0,0,0],[0,1,0,0],[1,1,0,0],[0,0,1,0],[1,0,1,0],[0,1,1,0],[1,1,1,0],[0,0,0,1],[1,0,0,1],[0,1,0,1],[1,1,0,1],[0,0,1,1],[1,0,1,1],[0,1,1,1],[1,1,1,1]],Lf=134480385,ea=16,J=-227,dd=482,Ce=[Wc,function(a){return a},function(a,b,c){return b[c+0]},function(a,b,c){return b[c+1]},function(a,b,c){return b[c-1]},function(a,b,c){return ka(ka(a,b[c+1]),b[c+0])},function(a,b,c){return ka(a,b[c-1])},function(a,b,c){return ka(a,b[c+0])},function(a,
b,c){return ka(b[c-1],b[c+0])},function(a,b,c){return ka(b[c+0],b[c+1])},function(a,b,c){return ka(ka(a,b[c-1]),ka(b[c+0],b[c+1]))},function(a,b,c){return 0>=Math.abs((a>>24&255)-(b[c-1]>>24&255))-Math.abs((b[c+0]>>24&255)-(b[c-1]>>24&255))+(Math.abs((a>>16&255)-(b[c-1]>>16&255))-Math.abs((b[c+0]>>16&255)-(b[c-1]>>16&255)))+(Math.abs((a>>8&255)-(b[c-1]>>8&255))-Math.abs((b[c+0]>>8&255)-(b[c-1]>>8&255)))+(Math.abs((a&255)-(b[c-1]&255))-Math.abs((b[c+0]&255)-(b[c-1]&255)))?b[c+0]:a},function(a,b,c){return($a((a>>
24&255)+(b[c+0]>>24&255)-(b[c-1]>>24&255))<<24|$a((a>>16&255)+(b[c+0]>>16&255)-(b[c-1]>>16&255))<<16|$a((a>>8&255)+(b[c+0]>>8&255)-(b[c-1]>>8&255))<<8|$a((a&255)+(b[c+0]&255)-(b[c-1]&255)))>>>0},function(a,b,c){var d=b[c-1];a=ka(a,b[c+0]);return(yb(a>>24&255,d>>24&255)<<24|yb(a>>16&255,d>>16&255)<<16|yb(a>>8&255,d>>8&255)<<8|yb(a>>0&255,d>>0&255))>>>0},Wc,Wc],Xf={Cc:x,Bc:x,Kc:x},$c=16,Me=16,kg=16,mg=[2,3,7],lg=[3,3,11],Zf=0,$f=1,ag=2,bg=3,cg=4,hg=[Ba+Ge,Ba,Ba,Ba,40],Ke=19,ig=[17,18,0,1,2,3,4,5,16,
6,7,8,9,10,11,12,13,14,15],He=120,dg=[24,7,23,25,40,6,39,41,22,26,38,42,56,5,55,57,21,27,54,58,37,43,72,4,71,73,20,28,53,59,70,74,36,44,88,69,75,52,60,3,87,89,19,29,86,90,35,45,68,76,85,91,51,61,104,2,103,105,18,30,102,106,34,46,84,92,67,77,101,107,50,62,120,1,119,121,83,93,17,31,100,108,66,78,118,122,33,47,117,123,49,63,99,109,82,94,0,116,124,65,79,16,32,98,110,48,115,125,81,95,64,114,126,97,111,80,113,127,96,112],Jb=1<<ea-1,Za=U(256,0),xb=U(256,0),vb=U(256,la),wb=U(256,la),ia=U(dd-J,x),Hb=U(dd-
J,x),Xe=0,V=Array(Cc),vg=[function(a,b,c,d,e,f,k,h,n,l,m,t,q){Ca(a,b,c,d,e,f,k,h,n,l,m,t,q,hc,3)},Se,function(a,b,c,d,e,f,k,h,n,l,m,t,q){Ca(a,b,c,d,e,f,k,h,n,l,m,t,q,Vc,3)},Te,Ue,Ve,function(a,b,c,d,e,f,k,h,n,l,m,t,q){Ca(a,b,c,d,e,f,k,h,n,l,m,t,q,le,2)},Se,Te,Ue,Ve];this.Hd=function(a,b,c,d){return lb(Qa,a,b,c,d)};this.Id=function(a,b,c,d){return lb(jb,a,b,c,d)};this.Jd=function(a,b,c,d){return lb(kb,a,b,c,d)};this.Ed=function(a,b,c,d){return lb(Ab,a,b,c,d)};this.Fd=function(a,b,c,d){return lb(Zc,
a,b,c,d)};this.Gd=function(a,b,c,d){return lb(Pa,a,b,c,d)};this.WebPDecode=this.Dd=function(a,b,c){var d=M(df),e="VP8StatusCode";if(c==p)return ta;e=hd(a,[0],[b],c.input);if(e!=L)return e==Z?W:e;d.j=c.j;d.Qa=c.Qa;return e=cf(a,0,[b],d)}};


}) ();// (c) Dean McNamee <dean@gmail.com>, 2013.
//
// https://github.com/deanm/omggif
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.
//
// omggif is a JavaScript implementation of a GIF 89a encoder and decoder,
// including animation and compression.  It does not rely on any specific
// underlying system, so should run in the browser, Node, or Plask.

function GifWriter(buf, width, height, gopts) {
  var p = 0;

  var gopts = gopts === undefined ? { } : gopts;
  var loop_count = gopts.loop === undefined ? null : gopts.loop;
  var global_palette = gopts.palette === undefined ? null : gopts.palette;

  if (width <= 0 || height <= 0 || width > 65535 || height > 65535)
    throw "Width/Height invalid."

  function check_palette_and_num_colors(palette) {
    var num_colors = palette.length;
    if (num_colors < 2 || num_colors > 256 ||  num_colors & (num_colors-1))
      throw "Invalid code/color length, must be power of 2 and 2 .. 256.";
    return num_colors;
  }

  // - Header.
  buf[p++] = 0x47; buf[p++] = 0x49; buf[p++] = 0x46;  // GIF
  buf[p++] = 0x38; buf[p++] = 0x39; buf[p++] = 0x61;  // 89a

  // Handling of Global Color Table (palette) and background index.
  var gp_num_colors_pow2 = 0;
  var background = 0;
  if (global_palette !== null) {
    var gp_num_colors = check_palette_and_num_colors(global_palette);
    while (gp_num_colors >>= 1) ++gp_num_colors_pow2;
    gp_num_colors = 1 << gp_num_colors_pow2;
    --gp_num_colors_pow2;
    if (gopts.background !== undefined) {
      background = gopts.background;
      if (background >= gp_num_colors) throw "Background index out of range.";
      // The GIF spec states that a background index of 0 should be ignored, so
      // this is probably a mistake and you really want to set it to another
      // slot in the palette.  But actually in the end most browsers, etc end
      // up ignoring this almost completely (including for dispose background).
      if (background === 0)
        throw "Background index explicitly passed as 0.";
    }
  }

  // - Logical Screen Descriptor.
  // NOTE(deanm): w/h apparently ignored by implementations, but set anyway.
  buf[p++] = width & 0xff; buf[p++] = width >> 8 & 0xff;
  buf[p++] = height & 0xff; buf[p++] = height >> 8 & 0xff;
  // NOTE: Indicates 0-bpp original color resolution (unused?).
  buf[p++] = (global_palette !== null ? 0x80 : 0) |  // Global Color Table Flag.
             gp_num_colors_pow2;  // NOTE: No sort flag (unused?).
  buf[p++] = background;  // Background Color Index.
  buf[p++] = 0;  // Pixel aspect ratio (unused?).

  // - Global Color Table
  if (global_palette !== null) {
    for (var i = 0, il = global_palette.length; i < il; ++i) {
      var rgb = global_palette[i];
      buf[p++] = rgb >> 16 & 0xff;
      buf[p++] = rgb >> 8 & 0xff;
      buf[p++] = rgb & 0xff;
    }
  }

  if (loop_count !== null) {  // Netscape block for looping.
    if (loop_count < 0 || loop_count > 65535)
      throw "Loop count invalid."
    // Extension code, label, and length.
    buf[p++] = 0x21; buf[p++] = 0xff; buf[p++] = 0x0b;
    // NETSCAPE2.0
    buf[p++] = 0x4e; buf[p++] = 0x45; buf[p++] = 0x54; buf[p++] = 0x53;
    buf[p++] = 0x43; buf[p++] = 0x41; buf[p++] = 0x50; buf[p++] = 0x45;
    buf[p++] = 0x32; buf[p++] = 0x2e; buf[p++] = 0x30;
    // Sub-block
    buf[p++] = 0x03; buf[p++] = 0x01;
    buf[p++] = loop_count & 0xff; buf[p++] = loop_count >> 8 & 0xff;
    buf[p++] = 0x00;  // Terminator.
  }


  var ended = false;

  this.addFrame = function(x, y, w, h, indexed_pixels, opts) {
    if (ended === true) { --p; ended = false; }  // Un-end.

    opts = opts === undefined ? { } : opts;

    // TODO(deanm): Bounds check x, y.  Do they need to be within the virtual
    // canvas width/height, I imagine?
    if (x < 0 || y < 0 || x > 65535 || y > 65535)
      throw "x/y invalid."

    if (w <= 0 || h <= 0 || w > 65535 || h > 65535)
      throw "Width/Height invalid."

    if (indexed_pixels.length < w * h)
      throw "Not enough pixels for the frame size.";

    var using_local_palette = true;
    var palette = opts.palette;
    if (palette === undefined || palette === null) {
      using_local_palette = false;
      palette = global_palette;
    }

    if (palette === undefined || palette === null)
      throw "Must supply either a local or global palette.";

    var num_colors = check_palette_and_num_colors(palette);

    // Compute the min_code_size (power of 2), destroying num_colors.
    var min_code_size = 0;
    while (num_colors >>= 1) ++min_code_size;
    num_colors = 1 << min_code_size;  // Now we can easily get it back.

    var delay = opts.delay === undefined ? 0 : opts.delay;

    // From the spec:
    //     0 -   No disposal specified. The decoder is
    //           not required to take any action.
    //     1 -   Do not dispose. The graphic is to be left
    //           in place.
    //     2 -   Restore to background color. The area used by the
    //           graphic must be restored to the background color.
    //     3 -   Restore to previous. The decoder is required to
    //           restore the area overwritten by the graphic with
    //           what was there prior to rendering the graphic.
    //  4-7 -    To be defined.
    // NOTE(deanm): Dispose background doesn't really work, apparently most
    // browsers ignore the background palette index and clear to transparency.
    var disposal = opts.disposal === undefined ? 0 : opts.disposal;
    if (disposal < 0 || disposal > 3)  // 4-7 is reserved.
      throw "Disposal out of range.";

    var use_transparency = false;
    var transparent_index = 0;
    if (opts.transparent !== undefined && opts.transparent !== null) {
      use_transparency = true;
      transparent_index = opts.transparent;
      if (transparent_index < 0 || transparent_index >= num_colors)
        throw "Transparent color index.";
    }

    if (disposal !== 0 || use_transparency || delay !== 0) {
      // - Graphics Control Extension
      buf[p++] = 0x21; buf[p++] = 0xf9;  // Extension / Label.
      buf[p++] = 4;  // Byte size.

      buf[p++] = disposal << 2 | (use_transparency === true ? 1 : 0);
      buf[p++] = delay & 0xff; buf[p++] = delay >> 8 & 0xff;
      buf[p++] = transparent_index;  // Transparent color index.
      buf[p++] = 0;  // Block Terminator.
    }

    // - Image Descriptor
    buf[p++] = 0x2c;  // Image Seperator.
    buf[p++] = x & 0xff; buf[p++] = x >> 8 & 0xff;  // Left.
    buf[p++] = y & 0xff; buf[p++] = y >> 8 & 0xff;  // Top.
    buf[p++] = w & 0xff; buf[p++] = w >> 8 & 0xff;
    buf[p++] = h & 0xff; buf[p++] = h >> 8 & 0xff;
    // NOTE: No sort flag (unused?).
    // TODO(deanm): Support interlace.
    buf[p++] = using_local_palette === true ? (0x80 | (min_code_size-1)) : 0;

    // - Local Color Table
    if (using_local_palette === true) {
      for (var i = 0, il = palette.length; i < il; ++i) {
        var rgb = palette[i];
        buf[p++] = rgb >> 16 & 0xff;
        buf[p++] = rgb >> 8 & 0xff;
        buf[p++] = rgb & 0xff;
      }
    }

    p = GifWriterOutputLZWCodeStream(
            buf, p, min_code_size < 2 ? 2 : min_code_size, indexed_pixels);
  };

  this.end = function() {
    if (ended === false) {
      buf[p++] = 0x3b;  // Trailer.
      ended = true;
    }
    return p;
  };
}

// Main compression routine, palette indexes -> LZW code stream.
// |index_stream| must have at least one entry.
function GifWriterOutputLZWCodeStream(buf, p, min_code_size, index_stream) {
  buf[p++] = min_code_size;
  var cur_subblock = p++;  // Pointing at the length field.

  var clear_code = 1 << min_code_size;
  var code_mask = clear_code - 1;
  var eoi_code = clear_code + 1;
  var next_code = eoi_code + 1;

  var cur_code_size = min_code_size + 1;  // Number of bits per code.
  var cur_shift = 0;
  // We have at most 12-bit codes, so we should have to hold a max of 19
  // bits here (and then we would write out).
  var cur = 0;

  function emit_bytes_to_buffer(bit_block_size) {
    while (cur_shift >= bit_block_size) {
      buf[p++] = cur & 0xff;
      cur >>= 8; cur_shift -= 8;
      if (p === cur_subblock + 256) {  // Finished a subblock.
        buf[cur_subblock] = 255;
        cur_subblock = p++;
      }
    }
  }

  function emit_code(c) {
    cur |= c << cur_shift;
    cur_shift += cur_code_size;
    emit_bytes_to_buffer(8);
  }

  // I am not an expert on the topic, and I don't want to write a thesis.
  // However, it is good to outline here the basic algorithm and the few data
  // structures and optimizations here that make this implementation fast.
  // The basic idea behind LZW is to build a table of previously seen runs
  // addressed by a short id (herein called output code).  All data is
  // referenced by a code, which represents one or more values from the
  // original input stream.  All input bytes can be referenced as the same
  // value as an output code.  So if you didn't want any compression, you
  // could more or less just output the original bytes as codes (there are
  // some details to this, but it is the idea).  In order to achieve
  // compression, values greater then the input range (codes can be up to
  // 12-bit while input only 8-bit) represent a sequence of previously seen
  // inputs.  The decompressor is able to build the same mapping while
  // decoding, so there is always a shared common knowledge between the
  // encoding and decoder, which is also important for "timing" aspects like
  // how to handle variable bit width code encoding.
  //
  // One obvious but very important consequence of the table system is there
  // is always a unique id (at most 12-bits) to map the runs.  'A' might be
  // 4, then 'AA' might be 10, 'AAA' 11, 'AAAA' 12, etc.  This relationship
  // can be used for an effecient lookup strategy for the code mapping.  We
  // need to know if a run has been seen before, and be able to map that run
  // to the output code.  Since we start with known unique ids (input bytes),
  // and then from those build more unique ids (table entries), we can
  // continue this chain (almost like a linked list) to always have small
  // integer values that represent the current byte chains in the encoder.
  // This means instead of tracking the input bytes (AAAABCD) to know our
  // current state, we can track the table entry for AAAABC (it is guaranteed
  // to exist by the nature of the algorithm) and the next character D.
  // Therefor the tuple of (table_entry, byte) is guaranteed to also be
  // unique.  This allows us to create a simple lookup key for mapping input
  // sequences to codes (table indices) without having to store or search
  // any of the code sequences.  So if 'AAAA' has a table entry of 12, the
  // tuple of ('AAAA', K) for any input byte K will be unique, and can be our
  // key.  This leads to a integer value at most 20-bits, which can always
  // fit in an SMI value and be used as a fast sparse array / object key.

  // Output code for the current contents of the index buffer.
  var ib_code = index_stream[0] & code_mask;  // Load first input index.
  var code_table = { };  // Key'd on our 20-bit "tuple".

  emit_code(clear_code);  // Spec says first code should be a clear code.

  // First index already loaded, process the rest of the stream.
  for (var i = 1, il = index_stream.length; i < il; ++i) {
    var k = index_stream[i] & code_mask;
    var cur_key = ib_code << 8 | k;  // (prev, k) unique tuple.
    var cur_code = code_table[cur_key];  // buffer + k.

    // Check if we have to create a new code table entry.
    if (cur_code === undefined) {  // We don't have buffer + k.
      // Emit index buffer (without k).
      // This is an inline version of emit_code, because this is the core
      // writing routine of the compressor (and V8 cannot inline emit_code
      // because it is a closure here in a different context).  Additionally
      // we can call emit_byte_to_buffer less often, because we can have
      // 30-bits (from our 31-bit signed SMI), and we know our codes will only
      // be 12-bits, so can safely have 18-bits there without overflow.
      // emit_code(ib_code);
      cur |= ib_code << cur_shift;
      cur_shift += cur_code_size;
      while (cur_shift >= 8) {
        buf[p++] = cur & 0xff;
        cur >>= 8; cur_shift -= 8;
        if (p === cur_subblock + 256) {  // Finished a subblock.
          buf[cur_subblock] = 255;
          cur_subblock = p++;
        }
      }

      if (next_code === 4096) {  // Table full, need a clear.
        emit_code(clear_code);
        next_code = eoi_code + 1;
        cur_code_size = min_code_size + 1;
        code_table = { };
      } else {  // Table not full, insert a new entry.
        // Increase our variable bit code sizes if necessary.  This is a bit
        // tricky as it is based on "timing" between the encoding and
        // decoder.  From the encoders perspective this should happen after
        // we've already emitted the index buffer and are about to create the
        // first table entry that would overflow our current code bit size.
        if (next_code >= (1 << cur_code_size)) ++cur_code_size;
        code_table[cur_key] = next_code++;  // Insert into code table.
      }

      ib_code = k;  // Index buffer to single input k.
    } else {
      ib_code = cur_code;  // Index buffer to sequence in code table.
    }
  }

  emit_code(ib_code);  // There will still be something in the index buffer.
  emit_code(eoi_code);  // End Of Information.

  // Flush / finalize the sub-blocks stream to the buffer.
  emit_bytes_to_buffer(1);

  // Finish the sub-blocks, writing out any unfinished lengths and
  // terminating with a sub-block of length 0.  If we have already started
  // but not yet used a sub-block it can just become the terminator.
  if (cur_subblock + 1 === p) {  // Started but unused.
    buf[cur_subblock] = 0;
  } else {  // Started and used, write length and additional terminator block.
    buf[cur_subblock] = p - cur_subblock - 1;
    buf[p++] = 0;
  }
  return p;
}

function GifReader(buf) {
  var p = 0;

  // - Header (GIF87a or GIF89a).
  if (buf[p++] !== 0x47 ||            buf[p++] !== 0x49 || buf[p++] !== 0x46 ||
      buf[p++] !== 0x38 || (buf[p++]+1 & 0xfd) !== 0x38 || buf[p++] !== 0x61) {
    throw "Invalid GIF 87a/89a header.";
  }

  // - Logical Screen Descriptor.
  var width = buf[p++] | buf[p++] << 8;
  var height = buf[p++] | buf[p++] << 8;
  var pf0 = buf[p++];  // <Packed Fields>.
  var global_palette_flag = pf0 >> 7;
  var num_global_colors_pow2 = pf0 & 0x7;
  var num_global_colors = 1 << (num_global_colors_pow2 + 1);
  var background = buf[p++];
  buf[p++];  // Pixel aspect ratio (unused?).

  var global_palette_offset = null;

  if (global_palette_flag) {
    global_palette_offset = p;
    p += num_global_colors * 3;  // Seek past palette.
  }

  var no_eof = true;

  var frames = [ ];

  var delay = 0;
  var transparent_index = null;
  var disposal = 0;  // 0 - No disposal specified.
  var loop_count = null;

  this.width = width;
  this.height = height;

  while (no_eof && p < buf.length) {
    switch (buf[p++]) {
      case 0x21:  // Graphics Control Extension Block
        switch (buf[p++]) {
          case 0xff:  // Application specific block
            // Try if it's a Netscape block (with animation loop counter).
            if (buf[p   ] !== 0x0b ||  // 21 FF already read, check block size.
                // NETSCAPE2.0
                buf[p+1 ] == 0x4e && buf[p+2 ] == 0x45 && buf[p+3 ] == 0x54 &&
                buf[p+4 ] == 0x53 && buf[p+5 ] == 0x43 && buf[p+6 ] == 0x41 &&
                buf[p+7 ] == 0x50 && buf[p+8 ] == 0x45 && buf[p+9 ] == 0x32 &&
                buf[p+10] == 0x2e && buf[p+11] == 0x30 &&
                // Sub-block
                buf[p+12] == 0x03 && buf[p+13] == 0x01 && buf[p+16] == 0) {
              p += 14;
              loop_count = buf[p++] | buf[p++] << 8;
              p++;  // Skip terminator.
            } else {  // We don't know what it is, just try to get past it.
              p += 12;
              while (true) {  // Seek through subblocks.
                var block_size = buf[p++];
                if (block_size === 0) break;
                p += block_size;
              }
            }
            break;

          case 0xf9:  // Graphics Control Extension
            if (buf[p++] !== 0x4 || buf[p+4] !== 0)
              throw "Invalid graphics extension block.";
            var pf1 = buf[p++];
            delay = buf[p++] | buf[p++] << 8;
            transparent_index = buf[p++];
            if ((pf1 & 1) === 0) transparent_index = null;
            disposal = pf1 >> 2 & 0x7;
            p++;  // Skip terminator.
            break;

          case 0xfe:  // Comment Extension.
            while (true) {  // Seek through subblocks.
              var block_size = buf[p++];
              if (block_size === 0) break;
              // console.log(buf.slice(p, p+block_size).toString('ascii'));
              p += block_size;
            }
            break;

          default:
            throw "Unknown graphic control label: 0x" + buf[p-1].toString(16);
        }
        break;

      case 0x2c:  // Image Descriptor.
        var x = buf[p++] | buf[p++] << 8;
        var y = buf[p++] | buf[p++] << 8;
        var w = buf[p++] | buf[p++] << 8;
        var h = buf[p++] | buf[p++] << 8;
        var pf2 = buf[p++];
        var local_palette_flag = pf2 >> 7;
        var interlace_flag = pf2 >> 6 & 1;
        var num_local_colors_pow2 = pf2 & 0x7;
        var num_local_colors = 1 << (num_local_colors_pow2 + 1);
        var palette_offset = global_palette_offset;
        var has_local_palette = false;
        if (local_palette_flag) {
          var has_local_palette = true;
          palette_offset = p;  // Override with local palette.
          p += num_local_colors * 3;  // Seek past palette.
        }

        var data_offset = p;

        p++;  // codesize
        while (true) {
          var block_size = buf[p++];
          if (block_size === 0) break;
          p += block_size;
        }

        frames.push({x: x, y: y, width: w, height: h,
                     has_local_palette: has_local_palette,
                     palette_offset: palette_offset,
                     data_offset: data_offset,
                     data_length: p - data_offset,
                     transparent_index: transparent_index,
                     interlaced: !!interlace_flag,
                     delay: delay,
                     disposal: disposal});
        break;

      case 0x3b:  // Trailer Marker (end of file).
        no_eof = false;
        break;

      default:
        throw "Unknown gif block: 0x" + buf[p-1].toString(16);
        break;
    }
  }

  this.numFrames = function() {
    return frames.length;
  };

  this.loopCount = function() {
    return loop_count;
  };

  this.frameInfo = function(frame_num) {
    if (frame_num < 0 || frame_num >= frames.length)
      throw "Frame index out of range.";
    return frames[frame_num];
  }


  // I will go to copy and paste hell one day...
  this.decodeAndBlitFrameRGBA = function(frame_num, pixels) {
    var frame = this.frameInfo(frame_num);	
    var num_pixels = frame.width * frame.height;
    var index_stream = new Uint8Array(num_pixels);  // At most 8-bit indices.
    GifReaderLZWOutputIndexStream(
        buf, frame.data_offset, index_stream, num_pixels);
    var palette_offset = frame.palette_offset;

    // NOTE(deanm): It seems to be much faster to compare index to 256 than
    // to === null.  Not sure why, but CompareStub_EQ_STRICT shows up high in
    // the profile, not sure if it's related to using a Uint8Array.
    var trans = frame.transparent_index;
    if (trans === null) trans = 256;

    // We are possibly just blitting to a portion of the entire frame.
    // That is a subrect within the framerect, so the additional pixels
    // must be skipped over after we finished a scanline.
    var framewidth  = frame.width;
    var framestride = width - framewidth;
    var xleft       = framewidth;  // Number of subrect pixels left in scanline.

    // Output indicies of the top left and bottom right corners of the subrect.
    var opbeg = ((frame.y * width) + frame.x) * 4;
    var opend = ((frame.y + frame.height) * width + frame.x) * 4;
    var op    = opbeg;

    var scanstride = framestride * 4;

    // Use scanstride to skip past the rows when interlacing.  This is skipping
    // 7 rows for the first two passes, then 3 then 1.
    if (frame.interlaced === true) {
      scanstride += width * 4 * 7;  // Pass 1.
    }

    var interlaceskip = 8;  // Tracking the row interval in the current pass.

    for (var i = 0, il = index_stream.length; i < il; ++i) {
      var index = index_stream[i];

      if (xleft === 0) {  // Beginning of new scan line
        op += scanstride;
        xleft = framewidth;
        if (op >= opend) { // Catch the wrap to switch passes when interlacing.
          scanstride = framestride * 4 + width * 4 * (interlaceskip-1);
          // interlaceskip / 2 * 4 is interlaceskip << 1.
          op = opbeg + (framewidth + framestride) * (interlaceskip << 1);
          interlaceskip >>= 1;
        }
      }

      if (index === trans) {
        op += 4;
      } else {
        var r = buf[palette_offset + index * 3];
        var g = buf[palette_offset + index * 3 + 1];
        var b = buf[palette_offset + index * 3 + 2];
        pixels[op++] = r;
        pixels[op++] = g;
        pixels[op++] = b;
        pixels[op++] = 255;
      }
      --xleft;
    }
  };
}

function GifReaderLZWOutputIndexStream(code_stream, p, output, output_length) {
  var min_code_size = code_stream[p++];

  var clear_code = 1 << min_code_size;
  var eoi_code = clear_code + 1;
  var next_code = eoi_code + 1;

  var cur_code_size = min_code_size + 1;  // Number of bits per code.
  // NOTE: This shares the same name as the encoder, but has a different
  // meaning here.  Here this masks each code coming from the code stream.
  var code_mask = (1 << cur_code_size) - 1;
  var cur_shift = 0;
  var cur = 0;

  var op = 0;  // Output pointer.
  
  var subblock_size = code_stream[p++];

  // TODO(deanm): Would using a TypedArray be any faster?  At least it would
  // solve the fast mode / backing store uncertainty.
  // var code_table = Array(4096);
  var code_table = new Int32Array(4096);  // Can be signed, we only use 20 bits.

  var prev_code = null;  // Track code-1.

  while (true) {
    // Read up to two bytes, making sure we always 12-bits for max sized code.
    while (cur_shift < 16) {
      if (subblock_size === 0) break;  // No more data to be read.

      cur |= code_stream[p++] << cur_shift;
      cur_shift += 8;

      if (subblock_size === 1) {  // Never let it get to 0 to hold logic above.
        subblock_size = code_stream[p++];  // Next subblock.
      } else {
        --subblock_size;
      }
    }

    // TODO(deanm): We should never really get here, we should have received
    // and EOI.
    if (cur_shift < cur_code_size)
      break;

    var code = cur & code_mask;
    cur >>= cur_code_size;
    cur_shift -= cur_code_size;

    // TODO(deanm): Maybe should check that the first code was a clear code,
    // at least this is what you're supposed to do.  But actually our encoder
    // now doesn't emit a clear code first anyway.
    if (code === clear_code) {
      // We don't actually have to clear the table.  This could be a good idea
      // for greater error checking, but we don't really do any anyway.  We
      // will just track it with next_code and overwrite old entries.

      next_code = eoi_code + 1;
      cur_code_size = min_code_size + 1;
      code_mask = (1 << cur_code_size) - 1;

      // Don't update prev_code ?
      prev_code = null;
      continue;
    } else if (code === eoi_code) {
      break;
    }

    // We have a similar situation as the decoder, where we want to store
    // variable length entries (code table entries), but we want to do in a
    // faster manner than an array of arrays.  The code below stores sort of a
    // linked list within the code table, and then "chases" through it to
    // construct the dictionary entries.  When a new entry is created, just the
    // last byte is stored, and the rest (prefix) of the entry is only
    // referenced by its table entry.  Then the code chases through the
    // prefixes until it reaches a single byte code.  We have to chase twice,
    // first to compute the length, and then to actually copy the data to the
    // output (backwards, since we know the length).  The alternative would be
    // storing something in an intermediate stack, but that doesn't make any
    // more sense.  I implemented an approach where it also stored the length
    // in the code table, although it's a bit tricky because you run out of
    // bits (12 + 12 + 8), but I didn't measure much improvements (the table
    // entries are generally not the long).  Even when I created benchmarks for
    // very long table entries the complexity did not seem worth it.
    // The code table stores the prefix entry in 12 bits and then the suffix
    // byte in 8 bits, so each entry is 20 bits.

    var chase_code = code < next_code ? code : prev_code;

    // Chase what we will output, either {CODE} or {CODE-1}.
    var chase_length = 0;
    var chase = chase_code;
    while (chase > clear_code) {
      chase = code_table[chase] >> 8;
      ++chase_length;
    }

    var k = chase;
    
    var op_end = op + chase_length + (chase_code !== code ? 1 : 0);
    if (op_end > output_length) {
      console.log("Warning, gif stream longer than expected.");
      return;
    }

    // Already have the first byte from the chase, might as well write it fast.
    output[op++] = k;

    op += chase_length;
    var b = op;  // Track pointer, writing backwards.

    if (chase_code !== code)  // The case of emitting {CODE-1} + k.
      output[op++] = k;

    chase = chase_code;
    while (chase_length--) {
      chase = code_table[chase];
      output[--b] = chase & 0xff;  // Write backwards.
      chase >>= 8;  // Pull down to the prefix code.
    }

    if (prev_code !== null && next_code < 4096) {
      code_table[next_code++] = prev_code << 8 | k;
      // TODO(deanm): Figure out this clearing vs code growth logic better.  I
      // have an feeling that it should just happen somewhere else, for now it
      // is awkward between when we grow past the max and then hit a clear code.
      // For now just check if we hit the max 12-bits (then a clear code should
      // follow, also of course encoded in 12-bits).
      if (next_code >= code_mask+1 && cur_code_size < 12) {
        ++cur_code_size;
        code_mask = code_mask << 1 | 1;
      }
    }

    prev_code = code;
  }

  if (op !== output_length) {
    console.log("Warning, gif stream shorter than expected.");
  }

  return output;
}

try { exports.GifWriter = GifWriter; exports.GifReader = GifReader } catch(e) { }  // CommonJS.
/*
 * A speed-improved perlin and simplex noise algorithms for 2D.
 *
 * Based on example code by Stefan Gustavson (stegu@itn.liu.se).
 * Optimisations by Peter Eastman (peastman@drizzle.stanford.edu).
 * Better rank ordering method by Stefan Gustavson in 2012.
 * Converted to Javascript by Joseph Gentle.
 *
 * Version 2012-03-09
 *
 * This code was placed in the public domain by its original author,
 * Stefan Gustavson. You may use it as you see fit, but
 * attribution is appreciated.
 *
 */

(function(global){
  var module = global.noise = {};

  function Grad(x, y, z) {
    this.x = x; this.y = y; this.z = z;
  }
  
  Grad.prototype.dot2 = function(x, y) {
    return this.x*x + this.y*y;
  };

  Grad.prototype.dot3 = function(x, y, z) {
    return this.x*x + this.y*y + this.z*z;
  };

  var grad3 = [new Grad(1,1,0),new Grad(-1,1,0),new Grad(1,-1,0),new Grad(-1,-1,0),
               new Grad(1,0,1),new Grad(-1,0,1),new Grad(1,0,-1),new Grad(-1,0,-1),
               new Grad(0,1,1),new Grad(0,-1,1),new Grad(0,1,-1),new Grad(0,-1,-1)];

  var p = [151,160,137,91,90,15,
  131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,8,99,37,240,21,10,23,
  190, 6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,35,11,32,57,177,33,
  88,237,149,56,87,174,20,125,136,171,168, 68,175,74,165,71,134,139,48,27,166,
  77,146,158,231,83,111,229,122,60,211,133,230,220,105,92,41,55,46,245,40,244,
  102,143,54, 65,25,63,161, 1,216,80,73,209,76,132,187,208, 89,18,169,200,196,
  135,130,116,188,159,86,164,100,109,198,173,186, 3,64,52,217,226,250,124,123,
  5,202,38,147,118,126,255,82,85,212,207,206,59,227,47,16,58,17,182,189,28,42,
  223,183,170,213,119,248,152, 2,44,154,163, 70,221,153,101,155,167, 43,172,9,
  129,22,39,253, 19,98,108,110,79,113,224,232,178,185, 112,104,218,246,97,228,
  251,34,242,193,238,210,144,12,191,179,162,241, 81,51,145,235,249,14,239,107,
  49,192,214, 31,181,199,106,157,184, 84,204,176,115,121,50,45,127, 4,150,254,
  138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180];
  // To remove the need for index wrapping, double the permutation table length
  var perm = new Array(512);
  var gradP = new Array(512);

  // This isn't a very good seeding function, but it works ok. It supports 2^16
  // different seed values. Write something better if you need more seeds.
  module.seed = function(seed) {
    if(seed > 0 && seed < 1) {
      // Scale the seed out
      seed *= 65536;
    }

    seed = Math.floor(seed);
    if(seed < 256) {
      seed |= seed << 8;
    }

    for(var i = 0; i < 256; i++) {
      var v;
      if (i & 1) {
        v = p[i] ^ (seed & 255);
      } else {
        v = p[i] ^ ((seed>>8) & 255);
      }

      perm[i] = perm[i + 256] = v;
      gradP[i] = gradP[i + 256] = grad3[v % 12];
    }
  };

  module.seed(0);

  /*
  for(var i=0; i<256; i++) {
    perm[i] = perm[i + 256] = p[i];
    gradP[i] = gradP[i + 256] = grad3[perm[i] % 12];
  }*/

  // Skewing and unskewing factors for 2, 3, and 4 dimensions
  var F2 = 0.5*(Math.sqrt(3)-1);
  var G2 = (3-Math.sqrt(3))/6;

  var F3 = 1/3;
  var G3 = 1/6;

  // 2D simplex noise
  module.simplex2 = function(xin, yin) {
    var n0, n1, n2; // Noise contributions from the three corners
    // Skew the input space to determine which simplex cell we're in
    var s = (xin+yin)*F2; // Hairy factor for 2D
    var i = Math.floor(xin+s);
    var j = Math.floor(yin+s);
    var t = (i+j)*G2;
    var x0 = xin-i+t; // The x,y distances from the cell origin, unskewed.
    var y0 = yin-j+t;
    // For the 2D case, the simplex shape is an equilateral triangle.
    // Determine which simplex we are in.
    var i1, j1; // Offsets for second (middle) corner of simplex in (i,j) coords
    if(x0>y0) { // lower triangle, XY order: (0,0)->(1,0)->(1,1)
      i1=1; j1=0;
    } else {    // upper triangle, YX order: (0,0)->(0,1)->(1,1)
      i1=0; j1=1;
    }
    // A step of (1,0) in (i,j) means a step of (1-c,-c) in (x,y), and
    // a step of (0,1) in (i,j) means a step of (-c,1-c) in (x,y), where
    // c = (3-sqrt(3))/6
    var x1 = x0 - i1 + G2; // Offsets for middle corner in (x,y) unskewed coords
    var y1 = y0 - j1 + G2;
    var x2 = x0 - 1 + 2 * G2; // Offsets for last corner in (x,y) unskewed coords
    var y2 = y0 - 1 + 2 * G2;
    // Work out the hashed gradient indices of the three simplex corners
    i &= 255;
    j &= 255;
    var gi0 = gradP[i+perm[j]];
    var gi1 = gradP[i+i1+perm[j+j1]];
    var gi2 = gradP[i+1+perm[j+1]];
    // Calculate the contribution from the three corners
    var t0 = 0.5 - x0*x0-y0*y0;
    if(t0<0) {
      n0 = 0;
    } else {
      t0 *= t0;
      n0 = t0 * t0 * gi0.dot2(x0, y0);  // (x,y) of grad3 used for 2D gradient
    }
    var t1 = 0.5 - x1*x1-y1*y1;
    if(t1<0) {
      n1 = 0;
    } else {
      t1 *= t1;
      n1 = t1 * t1 * gi1.dot2(x1, y1);
    }
    var t2 = 0.5 - x2*x2-y2*y2;
    if(t2<0) {
      n2 = 0;
    } else {
      t2 *= t2;
      n2 = t2 * t2 * gi2.dot2(x2, y2);
    }
    // Add contributions from each corner to get the final noise value.
    // The result is scaled to return values in the interval [-1,1].
    return 70 * (n0 + n1 + n2);
  };

  // 3D simplex noise
  module.simplex3 = function(xin, yin, zin) {
    var n0, n1, n2, n3; // Noise contributions from the four corners

    // Skew the input space to determine which simplex cell we're in
    var s = (xin+yin+zin)*F3; // Hairy factor for 2D
    var i = Math.floor(xin+s);
    var j = Math.floor(yin+s);
    var k = Math.floor(zin+s);

    var t = (i+j+k)*G3;
    var x0 = xin-i+t; // The x,y distances from the cell origin, unskewed.
    var y0 = yin-j+t;
    var z0 = zin-k+t;

    // For the 3D case, the simplex shape is a slightly irregular tetrahedron.
    // Determine which simplex we are in.
    var i1, j1, k1; // Offsets for second corner of simplex in (i,j,k) coords
    var i2, j2, k2; // Offsets for third corner of simplex in (i,j,k) coords
    if(x0 >= y0) {
      if(y0 >= z0)      { i1=1; j1=0; k1=0; i2=1; j2=1; k2=0; }
      else if(x0 >= z0) { i1=1; j1=0; k1=0; i2=1; j2=0; k2=1; }
      else              { i1=0; j1=0; k1=1; i2=1; j2=0; k2=1; }
    } else {
      if(y0 < z0)      { i1=0; j1=0; k1=1; i2=0; j2=1; k2=1; }
      else if(x0 < z0) { i1=0; j1=1; k1=0; i2=0; j2=1; k2=1; }
      else             { i1=0; j1=1; k1=0; i2=1; j2=1; k2=0; }
    }
    // A step of (1,0,0) in (i,j,k) means a step of (1-c,-c,-c) in (x,y,z),
    // a step of (0,1,0) in (i,j,k) means a step of (-c,1-c,-c) in (x,y,z), and
    // a step of (0,0,1) in (i,j,k) means a step of (-c,-c,1-c) in (x,y,z), where
    // c = 1/6.
    var x1 = x0 - i1 + G3; // Offsets for second corner
    var y1 = y0 - j1 + G3;
    var z1 = z0 - k1 + G3;

    var x2 = x0 - i2 + 2 * G3; // Offsets for third corner
    var y2 = y0 - j2 + 2 * G3;
    var z2 = z0 - k2 + 2 * G3;

    var x3 = x0 - 1 + 3 * G3; // Offsets for fourth corner
    var y3 = y0 - 1 + 3 * G3;
    var z3 = z0 - 1 + 3 * G3;

    // Work out the hashed gradient indices of the four simplex corners
    i &= 255;
    j &= 255;
    k &= 255;
    var gi0 = gradP[i+   perm[j+   perm[k   ]]];
    var gi1 = gradP[i+i1+perm[j+j1+perm[k+k1]]];
    var gi2 = gradP[i+i2+perm[j+j2+perm[k+k2]]];
    var gi3 = gradP[i+ 1+perm[j+ 1+perm[k+ 1]]];

    // Calculate the contribution from the four corners
    var t0 = 0.6 - x0*x0 - y0*y0 - z0*z0;
    if(t0<0) {
      n0 = 0;
    } else {
      t0 *= t0;
      n0 = t0 * t0 * gi0.dot3(x0, y0, z0);  // (x,y) of grad3 used for 2D gradient
    }
    var t1 = 0.6 - x1*x1 - y1*y1 - z1*z1;
    if(t1<0) {
      n1 = 0;
    } else {
      t1 *= t1;
      n1 = t1 * t1 * gi1.dot3(x1, y1, z1);
    }
    var t2 = 0.6 - x2*x2 - y2*y2 - z2*z2;
    if(t2<0) {
      n2 = 0;
    } else {
      t2 *= t2;
      n2 = t2 * t2 * gi2.dot3(x2, y2, z2);
    }
    var t3 = 0.6 - x3*x3 - y3*y3 - z3*z3;
    if(t3<0) {
      n3 = 0;
    } else {
      t3 *= t3;
      n3 = t3 * t3 * gi3.dot3(x3, y3, z3);
    }
    // Add contributions from each corner to get the final noise value.
    // The result is scaled to return values in the interval [-1,1].
    return 32 * (n0 + n1 + n2 + n3);

  };

  // ##### Perlin noise stuff

  function fade(t) {
    return t*t*t*(t*(t*6-15)+10);
  }

  function lerp(a, b, t) {
    return (1-t)*a + t*b;
  }

  // 2D Perlin Noise
  module.perlin2 = function(x, y) {
    // Find unit grid cell containing point
    var X = Math.floor(x), Y = Math.floor(y);
    // Get relative xy coordinates of point within that cell
    x = x - X; y = y - Y;
    // Wrap the integer cells at 255 (smaller integer period can be introduced here)
    X = X & 255; Y = Y & 255;

    // Calculate noise contributions from each of the four corners
    var n00 = gradP[X+perm[Y]].dot2(x, y);
    var n01 = gradP[X+perm[Y+1]].dot2(x, y-1);
    var n10 = gradP[X+1+perm[Y]].dot2(x-1, y);
    var n11 = gradP[X+1+perm[Y+1]].dot2(x-1, y-1);

    // Compute the fade curve value for x
    var u = fade(x);

    // Interpolate the four results
    return lerp(
        lerp(n00, n10, u),
        lerp(n01, n11, u),
       fade(y));
  };

  // 3D Perlin Noise
  module.perlin3 = function(x, y, z) {
    // Find unit grid cell containing point
    var X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    // Get relative xyz coordinates of point within that cell
    x = x - X; y = y - Y; z = z - Z;
    // Wrap the integer cells at 255 (smaller integer period can be introduced here)
    X = X & 255; Y = Y & 255; Z = Z & 255;

    // Calculate noise contributions from each of the eight corners
    var n000 = gradP[X+  perm[Y+  perm[Z  ]]].dot3(x,   y,     z);
    var n001 = gradP[X+  perm[Y+  perm[Z+1]]].dot3(x,   y,   z-1);
    var n010 = gradP[X+  perm[Y+1+perm[Z  ]]].dot3(x,   y-1,   z);
    var n011 = gradP[X+  perm[Y+1+perm[Z+1]]].dot3(x,   y-1, z-1);
    var n100 = gradP[X+1+perm[Y+  perm[Z  ]]].dot3(x-1,   y,   z);
    var n101 = gradP[X+1+perm[Y+  perm[Z+1]]].dot3(x-1,   y, z-1);
    var n110 = gradP[X+1+perm[Y+1+perm[Z  ]]].dot3(x-1, y-1,   z);
    var n111 = gradP[X+1+perm[Y+1+perm[Z+1]]].dot3(x-1, y-1, z-1);

    // Compute the fade curve value for x, y, z
    var u = fade(x);
    var v = fade(y);
    var w = fade(z);

    // Interpolate
    return lerp(
        lerp(
          lerp(n000, n100, u),
          lerp(n001, n101, u), w),
        lerp(
          lerp(n010, n110, u),
          lerp(n011, n111, u), w),
       v);
  };

})(this);


var Typr = {};

Typr.parse = function(buff)
{
	var bin = Typr._bin;
	var data = new Uint8Array(buff);
	var offset = 0;
	
	var sfnt_version = bin.readFixed(data, offset);
	offset += 4;
	var numTables = bin.readUshort(data, offset);
	offset += 2;
	var searchRange = bin.readUshort(data, offset);
	offset += 2;
	var entrySelector = bin.readUshort(data, offset);
	offset += 2;
	var rangeShift = bin.readUshort(data, offset);
	offset += 2;
	
	var tags = [
		"cmap",
		"head",
		"hhea",
		"maxp",
		"hmtx",
		"name",
		"OS/2",
		"post",
		
		//"cvt",
		//"fpgm",
		"loca",
		"glyf",
		"kern",
		
		//"prep"
		//"gasp"
		
		"CFF ",
		
		
		"GPOS",
		"GSUB",
		
		"SVG "
		//"VORG",
		];
	
	var obj = {_data:data};
	//console.log(sfnt_version, numTables, searchRange, entrySelector, rangeShift);
	
	var tabs = {};
	
	for(var i=0; i<numTables; i++)
	{
		var tag = bin.readASCII(data, offset, 4);   offset += 4;
		var checkSum = bin.readUint(data, offset);  offset += 4;
		var toffset = bin.readUint(data, offset);   offset += 4;
		var length = bin.readUint(data, offset);    offset += 4;
		tabs[tag] = {offset:toffset, length:length};
		
		//if(tags.indexOf(tag)==-1) console.log("unknown tag", tag, length);
	}
	
	for(var i=0; i< tags.length; i++)
	{
		var t = tags[i];
		//console.log(t);
		//if(tabs[t]) console.log(t, tabs[t].offset, tabs[t].length);
		if(tabs[t]) obj[t.trim()] = Typr[t.trim()].parse(data, tabs[t].offset, tabs[t].length, obj);
	}
	
	return obj;
}

Typr._tabOffset = function(data, tab)
{
	var bin = Typr._bin;
	var numTables = bin.readUshort(data, 4);
	var offset = 12;
	for(var i=0; i<numTables; i++)
	{
		var tag = bin.readASCII(data, offset, 4);   offset += 4;
		var checkSum = bin.readUint(data, offset);  offset += 4;
		var toffset = bin.readUint(data, offset);   offset += 4;
		var length = bin.readUint(data, offset);    offset += 4;
		if(tag==tab) return toffset;
	}
	return 0;
}





Typr._bin = {
	readFixed : function(data, o)
	{
		return ((data[o]<<8) | data[o+1]) +  (((data[o+2]<<8)|data[o+3])/(256*256+4));
	},
	readF2dot14 : function(data, o)
	{
		var num = Typr._bin.readShort(data, o);
		return num / 16384;
		
		var intg = (num >> 14), frac = ((num & 0x3fff)/(0x3fff+1));
		return (intg>0) ? (intg+frac) : (intg-frac);
	},
	readInt : function(buff, p)
	{
		//if(p>=buff.length) throw "error";
		var a = Typr._bin.t.uint8;
		a[0] = buff[p+3];
		a[1] = buff[p+2];
		a[2] = buff[p+1];
		a[3] = buff[p];
		return Typr._bin.t.int32[0];
	},
	
	readInt8 : function(buff, p)
	{
		//if(p>=buff.length) throw "error";
		var a = Typr._bin.t.uint8;
		a[0] = buff[p];
		return Typr._bin.t.int8[0];
	},
	readShort : function(buff, p)
	{
		//if(p>=buff.length) throw "error";
		var a = Typr._bin.t.uint8;
		a[1] = buff[p]; a[0] = buff[p+1];
		return Typr._bin.t.int16[0];
	},
	readUshort : function(buff, p)
	{
		//if(p>=buff.length) throw "error";
		return (buff[p]<<8) | buff[p+1];
	},
	readUshorts : function(buff, p, len)
	{
		var arr = [];
		for(var i=0; i<len; i++) arr.push(Typr._bin.readUshort(buff, p+i*2));
		return arr;
	},
	readUint : function(buff, p)
	{
		//if(p>=buff.length) throw "error";
		var a = Typr._bin.t.uint8;
		a[3] = buff[p];  a[2] = buff[p+1];  a[1] = buff[p+2];  a[0] = buff[p+3];
		return Typr._bin.t.uint32[0];
	},
	readUint64 : function(buff, p)
	{
		//if(p>=buff.length) throw "error";
		return (Typr._bin.readUint(buff, p)*(0xffffffff+1)) + Typr._bin.readUint(buff, p+4);
	},
	readASCII : function(buff, p, l)	// l : length in Characters (not Bytes)
	{
		//if(p>=buff.length) throw "error";
		var s = "";
		for(var i = 0; i < l; i++) s += String.fromCharCode(buff[p+i]);
		return s;
	},
	readUnicode : function(buff, p, l)
	{
		//if(p>=buff.length) throw "error";
		var s = "";
		for(var i = 0; i < l; i++)	
		{
			var c = (buff[p++]<<8) | buff[p++];
			s += String.fromCharCode(c);
		}
		return s;
	},
	_tdec : window["TextDecoder"] ? new window["TextDecoder"]() : null,
	readUTF8 : function(buff, p, l) {
		var tdec = Typr._bin._tdec;
		if(tdec && p==0 && l==buff.length) return tdec["decode"](buff);
		return Typr._bin.readASCII(buff,p,l);
	},
	readBytes : function(buff, p, l)
	{
		//if(p>=buff.length) throw "error";
		var arr = [];
		for(var i=0; i<l; i++) arr.push(buff[p+i]);
		return arr;
	},
	readASCIIArray : function(buff, p, l)	// l : length in Characters (not Bytes)
	{
		//if(p>=buff.length) throw "error";
		var s = [];
		for(var i = 0; i < l; i++)	
			s.push(String.fromCharCode(buff[p+i]));
		return s;
	}
};

Typr._bin.t = {
	buff: new ArrayBuffer(8),
};
Typr._bin.t.int8   = new Int8Array  (Typr._bin.t.buff);
Typr._bin.t.uint8  = new Uint8Array (Typr._bin.t.buff);
Typr._bin.t.int16  = new Int16Array (Typr._bin.t.buff);
Typr._bin.t.uint16 = new Uint16Array(Typr._bin.t.buff);
Typr._bin.t.int32  = new Int32Array (Typr._bin.t.buff);
Typr._bin.t.uint32 = new Uint32Array(Typr._bin.t.buff);





// OpenType Layout Common Table Formats

Typr._lctf = {};

Typr._lctf.parse = function(data, offset, length, font, subt)
{
	var bin = Typr._bin;
	var obj = {};
	var offset0 = offset;
	var tableVersion = bin.readFixed(data, offset);  offset += 4;
	
	var offScriptList  = bin.readUshort(data, offset);  offset += 2;
	var offFeatureList = bin.readUshort(data, offset);  offset += 2;
	var offLookupList  = bin.readUshort(data, offset);  offset += 2;
	
	
	obj.scriptList  = Typr._lctf.readScriptList (data, offset0 + offScriptList);
	obj.featureList = Typr._lctf.readFeatureList(data, offset0 + offFeatureList);
	obj.lookupList  = Typr._lctf.readLookupList (data, offset0 + offLookupList, subt);
	
	return obj;
}

Typr._lctf.readLookupList = function(data, offset, subt)
{
	var bin = Typr._bin;
	var offset0 = offset;
	var obj = [];
	var count = bin.readUshort(data, offset);  offset+=2;
	for(var i=0; i<count; i++) 
	{
		var noff = bin.readUshort(data, offset);  offset+=2;
		var lut = Typr._lctf.readLookupTable(data, offset0 + noff, subt);
		obj.push(lut);
	}
	return obj;
}

Typr._lctf.readLookupTable = function(data, offset, subt)
{
	//console.log("Parsing lookup table", offset);
	var bin = Typr._bin;
	var offset0 = offset;
	var obj = {tabs:[]};
	
	obj.ltype = bin.readUshort(data, offset);  offset+=2;
	obj.flag  = bin.readUshort(data, offset);  offset+=2;
	var cnt   = bin.readUshort(data, offset);  offset+=2;
	
	for(var i=0; i<cnt; i++)
	{
		var noff = bin.readUshort(data, offset);  offset+=2;
		var tab = subt(data, obj.ltype, offset0 + noff);
		//console.log(obj.type, tab);
		obj.tabs.push(tab);
	}
	return obj;
}

Typr._lctf.numOfOnes = function(n)
{
	var num = 0;
	for(var i=0; i<32; i++) if(((n>>>i)&1) != 0) num++;
	return num;
}

Typr._lctf.readClassDef = function(data, offset)
{
	var bin = Typr._bin;
	var obj = [];
	var format = bin.readUshort(data, offset);  offset+=2;
	if(format==1) 
	{
		var startGlyph  = bin.readUshort(data, offset);  offset+=2;
		var glyphCount  = bin.readUshort(data, offset);  offset+=2;
		for(var i=0; i<glyphCount; i++)
		{
			obj.push(startGlyph+i);
			obj.push(startGlyph+i);
			obj.push(bin.readUshort(data, offset));  offset+=2;
		}
	}
	if(format==2)
	{
		var count = bin.readUshort(data, offset);  offset+=2;
		for(var i=0; i<count; i++)
		{
			obj.push(bin.readUshort(data, offset));  offset+=2;
			obj.push(bin.readUshort(data, offset));  offset+=2;
			obj.push(bin.readUshort(data, offset));  offset+=2;
		}
	}
	return obj;
}
Typr._lctf.getInterval = function(tab, val)
{
	for(var i=0; i<tab.length; i+=3)
	{
		var start = tab[i], end = tab[i+1], index = tab[i+2];
		if(start<=val && val<=end) return i;
	}
	return -1;
}

Typr._lctf.readValueRecord = function(data, offset, valFmt)
{
	var bin = Typr._bin;
	var arr = [];
	arr.push( (valFmt&1) ? bin.readShort(data, offset) : 0 );  offset += (valFmt&1) ? 2 : 0;
	arr.push( (valFmt&2) ? bin.readShort(data, offset) : 0 );  offset += (valFmt&2) ? 2 : 0;
	arr.push( (valFmt&4) ? bin.readShort(data, offset) : 0 );  offset += (valFmt&4) ? 2 : 0;
	arr.push( (valFmt&8) ? bin.readShort(data, offset) : 0 );  offset += (valFmt&8) ? 2 : 0;
	return arr;
}

Typr._lctf.readCoverage = function(data, offset)
{
	var bin = Typr._bin;
	var cvg = {};
	cvg.fmt   = bin.readUshort(data, offset);  offset+=2;
	var count = bin.readUshort(data, offset);  offset+=2;
	//console.log("parsing coverage", offset-4, format, count);
	if(cvg.fmt==1) cvg.tab = bin.readUshorts(data, offset, count); 
	if(cvg.fmt==2) cvg.tab = bin.readUshorts(data, offset, count*3);
	return cvg;
}

Typr._lctf.coverageIndex = function(cvg, val)
{
	var tab = cvg.tab;
	if(cvg.fmt==1) return tab.indexOf(val);
	if(cvg.fmt==2) {
		var ind = Typr._lctf.getInterval(tab, val);
		if(ind!=-1) return tab[ind+2] + (val - tab[ind]);
	}
	return -1;
}

Typr._lctf.readFeatureList = function(data, offset)
{
	var bin = Typr._bin;
	var offset0 = offset;
	var obj = [];
	
	var count = bin.readUshort(data, offset);  offset+=2;
	
	for(var i=0; i<count; i++)
	{
		var tag = bin.readASCII(data, offset, 4);  offset+=4;
		var noff = bin.readUshort(data, offset);  offset+=2;
		obj.push({tag: tag.trim(), tab:Typr._lctf.readFeatureTable(data, offset0 + noff)});
	}
	return obj;
}

Typr._lctf.readFeatureTable = function(data, offset)
{
	var bin = Typr._bin;
	
	var featureParams = bin.readUshort(data, offset);  offset+=2;	// = 0
	var lookupCount = bin.readUshort(data, offset);  offset+=2;
	
	var indices = [];
	for(var i=0; i<lookupCount; i++) indices.push(bin.readUshort(data, offset+2*i));
	return indices;
}


Typr._lctf.readScriptList = function(data, offset)
{
	var bin = Typr._bin;
	var offset0 = offset;
	var obj = {};
	
	var count = bin.readUshort(data, offset);  offset+=2;
	
	for(var i=0; i<count; i++)
	{
		var tag = bin.readASCII(data, offset, 4);  offset+=4;
		var noff = bin.readUshort(data, offset);  offset+=2;
		obj[tag.trim()] = Typr._lctf.readScriptTable(data, offset0 + noff);
	}
	return obj;
}

Typr._lctf.readScriptTable = function(data, offset)
{
	var bin = Typr._bin;
	var offset0 = offset;
	var obj = {};
	
	var defLangSysOff = bin.readUshort(data, offset);  offset+=2;
	obj.default = Typr._lctf.readLangSysTable(data, offset0 + defLangSysOff);
	
	var langSysCount = bin.readUshort(data, offset);  offset+=2;
	
	for(var i=0; i<langSysCount; i++)
	{
		var tag = bin.readASCII(data, offset, 4);  offset+=4;
		var langSysOff = bin.readUshort(data, offset);  offset+=2;
		obj[tag.trim()] = Typr._lctf.readLangSysTable(data, offset0 + langSysOff);
	}
	return obj;
}

Typr._lctf.readLangSysTable = function(data, offset)
{
	var bin = Typr._bin;
	var obj = {};
	
	var lookupOrder = bin.readUshort(data, offset);  offset+=2;
	//if(lookupOrder!=0)  throw "lookupOrder not 0";
	obj.reqFeature = bin.readUshort(data, offset);  offset+=2;
	//if(obj.reqFeature != 0xffff) throw "reqFeatureIndex != 0xffff";
	
	//console.log(lookupOrder, obj.reqFeature);
	
	var featureCount = bin.readUshort(data, offset);  offset+=2;
	obj.features = bin.readUshorts(data, offset, featureCount);
	return obj;
}

	Typr.CFF = {};
	Typr.CFF.parse = function(data, offset, length)
	{
		var bin = Typr._bin;
		
		data = new Uint8Array(data.buffer, offset, length);
		offset = 0;
		
		// Header
		var major = data[offset];  offset++;
		var minor = data[offset];  offset++;
		var hdrSize = data[offset];  offset++;
		var offsize = data[offset];  offset++;
		//console.log(major, minor, hdrSize, offsize);
		
		// Name INDEX
		var ninds = [];
		offset = Typr.CFF.readIndex(data, offset, ninds);
		var names = [];
		
		for(var i=0; i<ninds.length-1; i++) names.push(bin.readASCII(data, offset+ninds[i], ninds[i+1]-ninds[i]));
		//console.log(names);
		offset += ninds[ninds.length-1];
		
		
		// Top DICT INDEX
		var tdinds = [];
		offset = Typr.CFF.readIndex(data, offset, tdinds);
		// Top DICT Data
		var topDicts = [];
		for(var i=0; i<tdinds.length-1; i++) topDicts.push( Typr.CFF.readDict(data, offset+tdinds[i], offset+tdinds[i+1]) );
		offset += tdinds[tdinds.length-1];
		var topdict = topDicts[0];
		//console.log(topdict);
		
		// String INDEX
		var sinds = [];
		offset = Typr.CFF.readIndex(data, offset, sinds);
		// String Data
		var strings = [];
		for(var i=0; i<sinds.length-1; i++) strings.push(bin.readASCII(data, offset+sinds[i], sinds[i+1]-sinds[i]));
		offset += sinds[sinds.length-1];
		
		// Global Subr INDEX  (subroutines)		
		Typr.CFF.readSubrs(data, offset, topdict);
		
		// charstrings
		if(topdict.CharStrings)
		{
			offset = topdict.CharStrings;
			var sinds = [];
			offset = Typr.CFF.readIndex(data, offset, sinds);
			
			var cstr = [];
			for(var i=0; i<sinds.length-1; i++) cstr.push(bin.readBytes(data, offset+sinds[i], sinds[i+1]-sinds[i]));
			//offset += sinds[sinds.length-1];
			topdict.CharStrings = cstr;
			//console.log(topdict.CharStrings);
		}
		
		// Encoding
		if(topdict.Encoding) topdict.Encoding = Typr.CFF.readEncoding(data, topdict.Encoding, topdict.CharStrings.length);
		
		// charset
		if(topdict.charset ) topdict.charset  = Typr.CFF.readCharset (data, topdict.charset , topdict.CharStrings.length);
		
		if(topdict.Private)
		{
			offset = topdict.Private[1];
			topdict.Private = Typr.CFF.readDict(data, offset, offset+topdict.Private[0]);
			if(topdict.Private.Subrs)  Typr.CFF.readSubrs(data, offset+topdict.Private.Subrs, topdict.Private);
		}
		
		var obj = {};
		for(var p in topdict)
		{
			if(["FamilyName", "FullName", "Notice", "version", "Copyright"].indexOf(p) != -1)  obj[p] = strings[topdict[p] -426 + 35 ];
			else obj[p] = topdict[p];
		}
		//console.log(obj);
		return obj;
	}
	
	Typr.CFF.readSubrs = function(data, offset, obj)
	{
		var bin = Typr._bin;
		var gsubinds = [];
		offset = Typr.CFF.readIndex(data, offset, gsubinds);
		
		var bias, nSubrs = gsubinds.length;
		if (false) bias = 0;
		else if (nSubrs <  1240) bias = 107;
		else if (nSubrs < 33900) bias = 1131;
		else bias = 32768;
		obj.Bias = bias;
		
		obj.Subrs = [];
		for(var i=0; i<gsubinds.length-1; i++) obj.Subrs.push(bin.readBytes(data, offset+gsubinds[i], gsubinds[i+1]-gsubinds[i]));
		//offset += gsubinds[gsubinds.length-1];
	}
	
	Typr.CFF.tableSE = [
      0,   0,   0,   0,   0,   0,   0,   0,
      0,   0,   0,   0,   0,   0,   0,   0,
      0,   0,   0,   0,   0,   0,   0,   0,
      0,   0,   0,   0,   0,   0,   0,   0,
      1,   2,   3,   4,   5,   6,   7,   8,
      9,  10,  11,  12,  13,  14,  15,  16,
     17,  18,  19,  20,  21,  22,  23,  24,
     25,  26,  27,  28,  29,  30,  31,  32,
     33,  34,  35,  36,  37,  38,  39,  40,
     41,  42,  43,  44,  45,  46,  47,  48,
     49,  50,  51,  52,  53,  54,  55,  56,
     57,  58,  59,  60,  61,  62,  63,  64,
     65,  66,  67,  68,  69,  70,  71,  72,
     73,  74,  75,  76,  77,  78,  79,  80,
     81,  82,  83,  84,  85,  86,  87,  88,
     89,  90,  91,  92,  93,  94,  95,   0,
      0,   0,   0,   0,   0,   0,   0,   0,
      0,   0,   0,   0,   0,   0,   0,   0,
      0,   0,   0,   0,   0,   0,   0,   0,
      0,   0,   0,   0,   0,   0,   0,   0,
      0,  96,  97,  98,  99, 100, 101, 102,
    103, 104, 105, 106, 107, 108, 109, 110,
      0, 111, 112, 113, 114,   0, 115, 116,
    117, 118, 119, 120, 121, 122,   0, 123,
      0, 124, 125, 126, 127, 128, 129, 130,
    131,   0, 132, 133,   0, 134, 135, 136,
    137,   0,   0,   0,   0,   0,   0,   0,
      0,   0,   0,   0,   0,   0,   0,   0,
      0, 138,   0, 139,   0,   0,   0,   0,
    140, 141, 142, 143,   0,   0,   0,   0,
      0, 144,   0,   0,   0, 145,   0,   0,
    146, 147, 148, 149,   0,   0,   0,   0
  ];
  
	Typr.CFF.glyphByUnicode = function(cff, code)
	{
		for(var i=0; i<cff.charset.length; i++) if(cff.charset[i]==code) return i;
		return -1;
	}
	
	Typr.CFF.glyphBySE = function(cff, charcode)	// glyph by standard encoding
	{
		if ( charcode < 0 || charcode > 255 ) return -1;
		return Typr.CFF.glyphByUnicode(cff, Typr.CFF.tableSE[charcode]);		
	}
	
	Typr.CFF.readEncoding = function(data, offset, num)
	{
		var bin = Typr._bin;
		
		var array = ['.notdef'];
		var format = data[offset];  offset++;
		//console.log("Encoding");
		//console.log(format);
		
		if(format==0)
		{
			var nCodes = data[offset];  offset++;
			for(var i=0; i<nCodes; i++)  array.push(data[offset+i]);
		}
		/*
		else if(format==1 || format==2)
		{
			while(charset.length<num)
			{
				var first = bin.readUshort(data, offset);  offset+=2;
				var nLeft=0;
				if(format==1) {  nLeft = data[offset];  offset++;  }
				else          {  nLeft = bin.readUshort(data, offset);  offset+=2;  }
				for(var i=0; i<=nLeft; i++)  {  charset.push(first);  first++;  }
			}
		}
		*/
		else throw "error: unknown encoding format: " + format;
		
		return array;
	}

	Typr.CFF.readCharset = function(data, offset, num)
	{
		var bin = Typr._bin;
		
		var charset = ['.notdef'];
		var format = data[offset];  offset++;
		
		if(format==0)
		{
			for(var i=0; i<num; i++) 
			{
				var first = bin.readUshort(data, offset);  offset+=2;
				charset.push(first);
			}
		}
		else if(format==1 || format==2)
		{
			while(charset.length<num)
			{
				var first = bin.readUshort(data, offset);  offset+=2;
				var nLeft=0;
				if(format==1) {  nLeft = data[offset];  offset++;  }
				else          {  nLeft = bin.readUshort(data, offset);  offset+=2;  }
				for(var i=0; i<=nLeft; i++)  {  charset.push(first);  first++;  }
			}
		}
		else throw "error: format: " + format;
		
		return charset;
	}

	Typr.CFF.readIndex = function(data, offset, inds)
	{
		var bin = Typr._bin;
		
		var count = bin.readUshort(data, offset);  offset+=2;
		var offsize = data[offset];  offset++;
		
		if     (offsize==1) for(var i=0; i<count+1; i++) inds.push( data[offset+i] );
		else if(offsize==2) for(var i=0; i<count+1; i++) inds.push( bin.readUshort(data, offset+i*2) );
		else if(offsize==3) for(var i=0; i<count+1; i++) inds.push( bin.readUint  (data, offset+i*3 - 1) & 0x00ffffff );
		else if(count!=0) throw "unsupported offset size: " + offsize + ", count: " + count;
		
		offset += (count+1)*offsize;
		return offset-1;
	}
	
	Typr.CFF.getCharString = function(data, offset, o)
	{
		var bin = Typr._bin;
		
		var b0 = data[offset], b1 = data[offset+1], b2 = data[offset+2], b3 = data[offset+3], b4=data[offset+4];
		var vs = 1;
		var op=null, val=null;
		// operand
		if(b0<=20) { op = b0;  vs=1;  }
		if(b0==12) { op = b0*100+b1;  vs=2;  }
		//if(b0==19 || b0==20) { op = b0/*+" "+b1*/;  vs=2; }
		if(21 <=b0 && b0<= 27) { op = b0;  vs=1; }
		if(b0==28) { val = bin.readShort(data,offset+1);  vs=3; }
		if(29 <=b0 && b0<= 31) { op = b0;  vs=1; }
		if(32 <=b0 && b0<=246) { val = b0-139;  vs=1; }
		if(247<=b0 && b0<=250) { val = (b0-247)*256+b1+108;  vs=2; }
		if(251<=b0 && b0<=254) { val =-(b0-251)*256-b1-108;  vs=2; }
		if(b0==255) {  val = bin.readInt(data, offset+1)/0xffff;  vs=5;   }
		
		o.val = val!=null ? val : "o"+op;
		o.size = vs;
	}
	
	Typr.CFF.readCharString = function(data, offset, length)
	{
		var end = offset + length;
		var bin = Typr._bin;
		var arr = [];
		
		while(offset<end)
		{
			var b0 = data[offset], b1 = data[offset+1], b2 = data[offset+2], b3 = data[offset+3], b4=data[offset+4];
			var vs = 1;
			var op=null, val=null;
			// operand
			if(b0<=20) { op = b0;  vs=1;  }
			if(b0==12) { op = b0*100+b1;  vs=2;  }
			if(b0==19 || b0==20) { op = b0/*+" "+b1*/;  vs=2; }
			if(21 <=b0 && b0<= 27) { op = b0;  vs=1; }
			if(b0==28) { val = bin.readShort(data,offset+1);  vs=3; }
			if(29 <=b0 && b0<= 31) { op = b0;  vs=1; }
			if(32 <=b0 && b0<=246) { val = b0-139;  vs=1; }
			if(247<=b0 && b0<=250) { val = (b0-247)*256+b1+108;  vs=2; }
			if(251<=b0 && b0<=254) { val =-(b0-251)*256-b1-108;  vs=2; }
			if(b0==255) {  val = bin.readInt(data, offset+1)/0xffff;  vs=5;   }
			
			arr.push(val!=null ? val : "o"+op);
			offset += vs;	

			//var cv = arr[arr.length-1];
			//if(cv==undefined) throw "error";
			//console.log()
		}	
		return arr;
	}

	Typr.CFF.readDict = function(data, offset, end)
	{
		var bin = Typr._bin;
		//var dict = [];
		var dict = {};
		var carr = [];
		
		while(offset<end)
		{
			var b0 = data[offset], b1 = data[offset+1], b2 = data[offset+2], b3 = data[offset+3], b4=data[offset+4];
			var vs = 1;
			var key=null, val=null;
			// operand
			if(b0==28) { val = bin.readShort(data,offset+1);  vs=3; }
			if(b0==29) { val = bin.readInt  (data,offset+1);  vs=5; }
			if(32 <=b0 && b0<=246) { val = b0-139;  vs=1; }
			if(247<=b0 && b0<=250) { val = (b0-247)*256+b1+108;  vs=2; }
			if(251<=b0 && b0<=254) { val =-(b0-251)*256-b1-108;  vs=2; }
			if(b0==255) {  val = bin.readInt(data, offset+1)/0xffff;  vs=5;  throw "unknown number";  }
			
			if(b0==30) 
			{  
				var nibs = [];
				vs = 1;
				while(true)
				{
					var b = data[offset+vs];  vs++;
					var nib0 = b>>4, nib1 = b&0xf;
					if(nib0 != 0xf) nibs.push(nib0);  if(nib1!=0xf) nibs.push(nib1);
					if(nib1==0xf) break;
				}
				var s = "";
				var chars = [0,1,2,3,4,5,6,7,8,9,".","e","e-","reserved","-","endOfNumber"];
				for(var i=0; i<nibs.length; i++) s += chars[nibs[i]];
				//console.log(nibs);
				val = parseFloat(s);
			}
			
			if(b0<=21)	// operator
			{
				var keys = ["version", "Notice", "FullName", "FamilyName", "Weight", "FontBBox", "BlueValues", "OtherBlues", "FamilyBlues","FamilyOtherBlues",
					"StdHW", "StdVW", "escape", "UniqueID", "XUID", "charset", "Encoding", "CharStrings", "Private", "Subrs", 
					"defaultWidthX", "nominalWidthX"];
					
				key = keys[b0];  vs=1;
				if(b0==12) { 
					var keys = [ "Copyright", "isFixedPitch", "ItalicAngle", "UnderlinePosition", "UnderlineThickness", "PaintType", "CharstringType", "FontMatrix", "StrokeWidth", "BlueScale",
					"BlueShift", "BlueFuzz", "StemSnapH", "StemSnapV", "ForceBold", 0,0, "LanguageGroup", "ExpansionFactor", "initialRandomSeed",
					"SyntheticBase", "PostScript", "BaseFontName", "BaseFontBlend", 0,0,0,0,0,0, 
					"ROS", "CIDFontVersion", "CIDFontRevision", "CIDFontType", "CIDCount", "UIDBase", "FDArray", "FDSelect", "FontName"];
					key = keys[b1];  vs=2; 
				}
			}
			
			if(key!=null) {  dict[key] = carr.length==1 ? carr[0] : carr;  carr=[]; }
			else  carr.push(val);  
			
			offset += vs;		
		}	
		return dict;
	}


Typr.cmap = {};
Typr.cmap.parse = function(data, offset, length)
{
	data = new Uint8Array(data.buffer, offset, length);
	offset = 0;

	var offset0 = offset;
	var bin = Typr._bin;
	var obj = {};
	var version   = bin.readUshort(data, offset);  offset += 2;
	var numTables = bin.readUshort(data, offset);  offset += 2;
	
	//console.log(version, numTables);
	
	var offs = [];
	obj.tables = [];
	
	
	for(var i=0; i<numTables; i++)
	{
		var platformID = bin.readUshort(data, offset);  offset += 2;
		var encodingID = bin.readUshort(data, offset);  offset += 2;
		var noffset = bin.readUint(data, offset);       offset += 4;
		
		var id = "p"+platformID+"e"+encodingID;
		
		//console.log("cmap subtable", platformID, encodingID, noffset);
		
		
		var tind = offs.indexOf(noffset);
		
		if(tind==-1)
		{
			tind = obj.tables.length;
			var subt;
			offs.push(noffset);
			var format = bin.readUshort(data, noffset);
			if     (format== 0) subt = Typr.cmap.parse0(data, noffset);
			else if(format== 4) subt = Typr.cmap.parse4(data, noffset);
			else if(format== 6) subt = Typr.cmap.parse6(data, noffset);
			else if(format==12) subt = Typr.cmap.parse12(data,noffset);
			else console.log("unknown format: "+format, platformID, encodingID, noffset);
			obj.tables.push(subt);
		}
		
		if(obj[id]!=null) throw "multiple tables for one platform+encoding";
		obj[id] = tind;
	}
	return obj;
}

Typr.cmap.parse0 = function(data, offset)
{
	var bin = Typr._bin;
	var obj = {};
	obj.format = bin.readUshort(data, offset);  offset += 2;
	var len    = bin.readUshort(data, offset);  offset += 2;
	var lang   = bin.readUshort(data, offset);  offset += 2;
	obj.map = [];
	for(var i=0; i<len-6; i++) obj.map.push(data[offset+i]);
	return obj;
}

Typr.cmap.parse4 = function(data, offset)
{
	var bin = Typr._bin;
	var offset0 = offset;
	var obj = {};
	
	obj.format = bin.readUshort(data, offset);  offset+=2;
	var length = bin.readUshort(data, offset);  offset+=2;
	var language = bin.readUshort(data, offset);  offset+=2;
	var segCountX2 = bin.readUshort(data, offset);  offset+=2;
	var segCount = segCountX2/2;
	obj.searchRange = bin.readUshort(data, offset);  offset+=2;
	obj.entrySelector = bin.readUshort(data, offset);  offset+=2;
	obj.rangeShift = bin.readUshort(data, offset);  offset+=2;
	obj.endCount   = bin.readUshorts(data, offset, segCount);  offset += segCount*2;
	offset+=2;
	obj.startCount = bin.readUshorts(data, offset, segCount);  offset += segCount*2;
	obj.idDelta = [];
	for(var i=0; i<segCount; i++) {obj.idDelta.push(bin.readShort(data, offset));  offset+=2;}
	obj.idRangeOffset = bin.readUshorts(data, offset, segCount);  offset += segCount*2;
	obj.glyphIdArray = [];
	while(offset< offset0+length) {obj.glyphIdArray.push(bin.readUshort(data, offset));  offset+=2;}
	return obj;
}

Typr.cmap.parse6 = function(data, offset)
{
	var bin = Typr._bin;
	var offset0 = offset;
	var obj = {};
	
	obj.format = bin.readUshort(data, offset);  offset+=2;
	var length = bin.readUshort(data, offset);  offset+=2;
	var language = bin.readUshort(data, offset);  offset+=2;
	obj.firstCode = bin.readUshort(data, offset);  offset+=2;
	var entryCount = bin.readUshort(data, offset);  offset+=2;
	obj.glyphIdArray = [];
	for(var i=0; i<entryCount; i++) {obj.glyphIdArray.push(bin.readUshort(data, offset));  offset+=2;}
	
	return obj;
}

Typr.cmap.parse12 = function(data, offset)
{
	var bin = Typr._bin;
	var offset0 = offset;
	var obj = {};
	
	obj.format = bin.readUshort(data, offset);  offset+=2;
	offset += 2;
	var length = bin.readUint(data, offset);  offset+=4;
	var lang   = bin.readUint(data, offset);  offset+=4;
	var nGroups= bin.readUint(data, offset);  offset+=4;
	obj.groups = [];
	
	for(var i=0; i<nGroups; i++)  
	{
		var off = offset + i * 12;
		var startCharCode = bin.readUint(data, off+0);
		var endCharCode   = bin.readUint(data, off+4);
		var startGlyphID  = bin.readUint(data, off+8);
		obj.groups.push([  startCharCode, endCharCode, startGlyphID  ]);
	}
	return obj;
}

Typr.glyf = {};
Typr.glyf.parse = function(data, offset, length, font)
{
	var obj = [];
	for(var g=0; g<font.maxp.numGlyphs; g++) obj.push(null);
	return obj;
}

Typr.glyf._parseGlyf = function(font, g)
{
	var bin = Typr._bin;
	var data = font._data;
	
	var offset = Typr._tabOffset(data, "glyf") + font.loca[g];
		
	if(font.loca[g]==font.loca[g+1]) return null;
		
	var gl = {};
		
	gl.noc  = bin.readShort(data, offset);  offset+=2;		// number of contours
	gl.xMin = bin.readShort(data, offset);  offset+=2;
	gl.yMin = bin.readShort(data, offset);  offset+=2;
	gl.xMax = bin.readShort(data, offset);  offset+=2;
	gl.yMax = bin.readShort(data, offset);  offset+=2;
	
	if(gl.xMin>=gl.xMax || gl.yMin>=gl.yMax) return null;
		
	if(gl.noc>0)
	{
		gl.endPts = [];
		for(var i=0; i<gl.noc; i++) { gl.endPts.push(bin.readUshort(data,offset)); offset+=2; }
		
		var instructionLength = bin.readUshort(data,offset); offset+=2;
		if((data.length-offset)<instructionLength) return null;
		gl.instructions = bin.readBytes(data, offset, instructionLength);   offset+=instructionLength;
		
		var crdnum = gl.endPts[gl.noc-1]+1;
		gl.flags = [];
		for(var i=0; i<crdnum; i++ ) 
		{ 
			var flag = data[offset];  offset++; 
			gl.flags.push(flag); 
			if((flag&8)!=0)
			{
				var rep = data[offset];  offset++;
				for(var j=0; j<rep; j++) { gl.flags.push(flag); i++; }
			}
		}
		gl.xs = [];
		for(var i=0; i<crdnum; i++) {
			var i8=((gl.flags[i]&2)!=0), same=((gl.flags[i]&16)!=0);  
			if(i8) { gl.xs.push(same ? data[offset] : -data[offset]);  offset++; }
			else
			{
				if(same) gl.xs.push(0);
				else { gl.xs.push(bin.readShort(data, offset));  offset+=2; }
			}
		}
		gl.ys = [];
		for(var i=0; i<crdnum; i++) {
			var i8=((gl.flags[i]&4)!=0), same=((gl.flags[i]&32)!=0);  
			if(i8) { gl.ys.push(same ? data[offset] : -data[offset]);  offset++; }
			else
			{
				if(same) gl.ys.push(0);
				else { gl.ys.push(bin.readShort(data, offset));  offset+=2; }
			}
		}
		var x = 0, y = 0;
		for(var i=0; i<crdnum; i++) { x += gl.xs[i]; y += gl.ys[i];  gl.xs[i]=x;  gl.ys[i]=y; }
		//console.log(endPtsOfContours, instructionLength, instructions, flags, xCoordinates, yCoordinates);
	}
	else
	{
		var ARG_1_AND_2_ARE_WORDS	= 1<<0;
		var ARGS_ARE_XY_VALUES		= 1<<1;
		var ROUND_XY_TO_GRID		= 1<<2;
		var WE_HAVE_A_SCALE			= 1<<3;
		var RESERVED				= 1<<4;
		var MORE_COMPONENTS			= 1<<5;
		var WE_HAVE_AN_X_AND_Y_SCALE= 1<<6;
		var WE_HAVE_A_TWO_BY_TWO	= 1<<7;
		var WE_HAVE_INSTRUCTIONS	= 1<<8;
		var USE_MY_METRICS			= 1<<9;
		var OVERLAP_COMPOUND		= 1<<10;
		var SCALED_COMPONENT_OFFSET	= 1<<11;
		var UNSCALED_COMPONENT_OFFSET	= 1<<12;
		
		gl.parts = [];
		var flags;
		do {
			flags = bin.readUshort(data, offset);  offset += 2;
			var part = { m:{a:1,b:0,c:0,d:1,tx:0,ty:0}, p1:-1, p2:-1 };  gl.parts.push(part);
			part.glyphIndex = bin.readUshort(data, offset);  offset += 2;
			if ( flags & ARG_1_AND_2_ARE_WORDS) {
				var arg1 = bin.readShort(data, offset);  offset += 2;
				var arg2 = bin.readShort(data, offset);  offset += 2;
			} else {
				var arg1 = bin.readInt8(data, offset);  offset ++;
				var arg2 = bin.readInt8(data, offset);  offset ++;
			}
			
			if(flags & ARGS_ARE_XY_VALUES) { part.m.tx = arg1;  part.m.ty = arg2; }
			else  {  part.p1=arg1;  part.p2=arg2;  }
			//part.m.tx = arg1;  part.m.ty = arg2;
			//else { throw "params are not XY values"; }
			
			if ( flags & WE_HAVE_A_SCALE ) {
				part.m.a = part.m.d = bin.readF2dot14(data, offset);  offset += 2;    
			} else if ( flags & WE_HAVE_AN_X_AND_Y_SCALE ) {
				part.m.a = bin.readF2dot14(data, offset);  offset += 2; 
				part.m.d = bin.readF2dot14(data, offset);  offset += 2; 
			} else if ( flags & WE_HAVE_A_TWO_BY_TWO ) {
				part.m.a = bin.readF2dot14(data, offset);  offset += 2; 
				part.m.b = bin.readF2dot14(data, offset);  offset += 2; 
				part.m.c = bin.readF2dot14(data, offset);  offset += 2; 
				part.m.d = bin.readF2dot14(data, offset);  offset += 2; 
			}
		} while ( flags & MORE_COMPONENTS ) 
		if (flags & WE_HAVE_INSTRUCTIONS){
			var numInstr = bin.readUshort(data, offset);  offset += 2;
			gl.instr = [];
			for(var i=0; i<numInstr; i++) { gl.instr.push(data[offset]);  offset++; }
		}
	}
	return gl;
}


Typr.GPOS = {};
Typr.GPOS.parse = function(data, offset, length, font) {  return Typr._lctf.parse(data, offset, length, font, Typr.GPOS.subt);  }



Typr.GPOS.subt = function(data, ltype, offset)	// lookup type
{
	if(ltype!=2) return null;
	
	var bin = Typr._bin, offset0 = offset, tab = {};
	
	tab.format  = bin.readUshort(data, offset);  offset+=2;
	var covOff  = bin.readUshort(data, offset);  offset+=2;
	tab.coverage = Typr._lctf.readCoverage(data, covOff+offset0);
	tab.valFmt1 = bin.readUshort(data, offset);  offset+=2;
	tab.valFmt2 = bin.readUshort(data, offset);  offset+=2;
	var ones1 = Typr._lctf.numOfOnes(tab.valFmt1);
	var ones2 = Typr._lctf.numOfOnes(tab.valFmt2);
	if(tab.format==1)
	{
		tab.pairsets = [];
		var count = bin.readUshort(data, offset);  offset+=2;
		
		for(var i=0; i<count; i++)
		{
			var psoff = bin.readUshort(data, offset);  offset+=2;
			psoff += offset0;
			var pvcount = bin.readUshort(data, psoff);  psoff+=2;
			var arr = [];
			for(var j=0; j<pvcount; j++)
			{
				var gid2 = bin.readUshort(data, psoff);  psoff+=2;
				var value1, value2;
				if(tab.valFmt1!=0) {  value1 = Typr._lctf.readValueRecord(data, psoff, tab.valFmt1);  psoff+=ones1*2;  }
				if(tab.valFmt2!=0) {  value2 = Typr._lctf.readValueRecord(data, psoff, tab.valFmt2);  psoff+=ones2*2;  }
				arr.push({gid2:gid2, val1:value1, val2:value2});
			}
			tab.pairsets.push(arr);
		}
	}
	if(tab.format==2)
	{
		var classDef1 = bin.readUshort(data, offset);  offset+=2;
		var classDef2 = bin.readUshort(data, offset);  offset+=2;
		var class1Count = bin.readUshort(data, offset);  offset+=2;
		var class2Count = bin.readUshort(data, offset);  offset+=2;
		
		tab.classDef1 = Typr._lctf.readClassDef(data, offset0 + classDef1);
		tab.classDef2 = Typr._lctf.readClassDef(data, offset0 + classDef2);
		
		tab.matrix = [];
		for(var i=0; i<class1Count; i++)
		{
			var row = [];
			for(var j=0; j<class2Count; j++)
			{
				var value1 = null, value2 = null;
				if(tab.valFmt1!=0) { value1 = Typr._lctf.readValueRecord(data, offset, tab.valFmt1);  offset+=ones1*2; }
				if(tab.valFmt2!=0) { value2 = Typr._lctf.readValueRecord(data, offset, tab.valFmt2);  offset+=ones2*2; }
				row.push({val1:value1, val2:value2});
			}
			tab.matrix.push(row);
		}
	}
	return tab;
}

Typr.GSUB = {};
Typr.GSUB.parse = function(data, offset, length, font) {  return Typr._lctf.parse(data, offset, length, font, Typr.GSUB.subt);  }


Typr.GSUB.subt = function(data, ltype, offset)	// lookup type
{
	var bin = Typr._bin, offset0 = offset, tab = {};
	
	if(ltype!=1 && ltype!=4 && ltype!=5) return null;
	
	tab.fmt  = bin.readUshort(data, offset);  offset+=2;
	var covOff  = bin.readUshort(data, offset);  offset+=2;
	tab.coverage = Typr._lctf.readCoverage(data, covOff+offset0);	// not always is coverage here
	
	if(false) {}
	//  Single Substitution Subtable
	else if(ltype==1) {	
		if(tab.fmt==1) {
			tab.delta = bin.readShort(data, offset);  offset+=2;
		}
		else if(tab.fmt==2) {
			var cnt = bin.readUshort(data, offset);  offset+=2;
			tab.newg = bin.readUshorts(data, offset, cnt);  offset+=tab.newg.length*2;
		}
	}
	//  Ligature Substitution Subtable
	else if(ltype==4) {
		tab.vals = [];
		var cnt = bin.readUshort(data, offset);  offset+=2;
		for(var i=0; i<cnt; i++) {
			var loff = bin.readUshort(data, offset);  offset+=2;
			tab.vals.push(Typr.GSUB.readLigatureSet(data, offset0+loff));
		}
		//console.log(tab.coverage);
		//console.log(tab.vals);
	} 
	//  Contextual Substitution Subtable
	else if(ltype==5) {
		if(tab.fmt==2) {
			var cDefOffset = bin.readUshort(data, offset);  offset+=2;
			tab.cDef = Typr._lctf.readClassDef(data, offset0 + cDefOffset);
			tab.scset = [];
			var subClassSetCount = bin.readUshort(data, offset);  offset+=2;
			for(var i=0; i<subClassSetCount; i++)
			{
				var scsOff = bin.readUshort(data, offset);  offset+=2;
				tab.scset.push(  scsOff==0 ? null : Typr.GSUB.readSubClassSet(data, offset0 + scsOff)  );
			}
		}
		else console.log("unknown table format", tab.fmt);
	}
	
	/*
	else if(ltype==6) {
		if(fmt==2) {
			var btDef = bin.readUshort(data, offset);  offset+=2;
			var inDef = bin.readUshort(data, offset);  offset+=2;
			var laDef = bin.readUshort(data, offset);  offset+=2;
			
			tab.btDef = Typr._lctf.readClassDef(data, offset0 + btDef);
			tab.inDef = Typr._lctf.readClassDef(data, offset0 + inDef);
			tab.laDef = Typr._lctf.readClassDef(data, offset0 + laDef);
			
			tab.scset = [];
			var cnt = bin.readUshort(data, offset);  offset+=2;
			for(var i=0; i<cnt; i++) {
				var loff = bin.readUshort(data, offset);  offset+=2;
				tab.scset.push(Typr.GSUB.readChainSubClassSet(data, offset0+loff));
			}
		}
	} */
	//if(tab.coverage.indexOf(3)!=-1) console.log(ltype, fmt, tab);
	
	return tab;
}

Typr.GSUB.readSubClassSet = function(data, offset)
{
	var rUs = Typr._bin.readUshort, offset0 = offset, lset = [];
	var cnt = rUs(data, offset);  offset+=2;
	for(var i=0; i<cnt; i++) {
		var loff = rUs(data, offset);  offset+=2;
		lset.push(Typr.GSUB.readSubClassRule(data, offset0+loff));
	}
	return lset;
}
Typr.GSUB.readSubClassRule= function(data, offset)
{
	var rUs = Typr._bin.readUshort, offset0 = offset, rule = {};
	var gcount = rUs(data, offset);  offset+=2;
	var scount = rUs(data, offset);  offset+=2;
	rule.input = [];
	for(var i=0; i<gcount-1; i++) {
		rule.input.push(rUs(data, offset));  offset+=2;
	}
	rule.substLookupRecords = Typr.GSUB.readSubstLookupRecords(data, offset, scount);
	return rule;
}
Typr.GSUB.readSubstLookupRecords = function(data, offset, cnt)
{
	var rUs = Typr._bin.readUshort;
	var out = [];
	for(var i=0; i<cnt; i++) {  out.push(rUs(data, offset), rUs(data, offset+2));  offset+=4;  }
	return out;
}

Typr.GSUB.readChainSubClassSet = function(data, offset)
{
	var bin = Typr._bin, offset0 = offset, lset = [];
	var cnt = bin.readUshort(data, offset);  offset+=2;
	for(var i=0; i<cnt; i++) {
		var loff = bin.readUshort(data, offset);  offset+=2;
		lset.push(Typr.GSUB.readChainSubClassRule(data, offset0+loff));
	}
	return lset;
}
Typr.GSUB.readChainSubClassRule= function(data, offset)
{
	var bin = Typr._bin, offset0 = offset, rule = {};
	var pps = ["backtrack", "input", "lookahead"];
	for(var pi=0; pi<pps.length; pi++) {
		var cnt = bin.readUshort(data, offset);  offset+=2;  if(pi==1) cnt--;
		rule[pps[pi]]=bin.readUshorts(data, offset, cnt);  offset+= rule[pps[pi]].length*2;
	}
	var cnt = bin.readUshort(data, offset);  offset+=2;
	rule.subst = bin.readUshorts(data, offset, cnt*2);  offset += rule.subst.length*2;
	return rule;
}

Typr.GSUB.readLigatureSet = function(data, offset)
{
	var bin = Typr._bin, offset0 = offset, lset = [];
	var lcnt = bin.readUshort(data, offset);  offset+=2;
	for(var j=0; j<lcnt; j++) {
		var loff = bin.readUshort(data, offset);  offset+=2;
		lset.push(Typr.GSUB.readLigature(data, offset0+loff));
	}
	return lset;
}
Typr.GSUB.readLigature = function(data, offset)
{
	var bin = Typr._bin, lig = {chain:[]};
	lig.nglyph = bin.readUshort(data, offset);  offset+=2;
	var ccnt = bin.readUshort(data, offset);  offset+=2;
	for(var k=0; k<ccnt-1; k++) {  lig.chain.push(bin.readUshort(data, offset));  offset+=2;  }
	return lig;
}



Typr.head = {};
Typr.head.parse = function(data, offset, length)
{
	var bin = Typr._bin;
	var obj = {};
	var tableVersion = bin.readFixed(data, offset);  offset += 4;
	obj.fontRevision = bin.readFixed(data, offset);  offset += 4;
	var checkSumAdjustment = bin.readUint(data, offset);  offset += 4;
	var magicNumber = bin.readUint(data, offset);  offset += 4;
	obj.flags = bin.readUshort(data, offset);  offset += 2;
	obj.unitsPerEm = bin.readUshort(data, offset);  offset += 2;
	obj.created  = bin.readUint64(data, offset);  offset += 8;
	obj.modified = bin.readUint64(data, offset);  offset += 8;
	obj.xMin = bin.readShort(data, offset);  offset += 2;
	obj.yMin = bin.readShort(data, offset);  offset += 2;
	obj.xMax = bin.readShort(data, offset);  offset += 2;
	obj.yMax = bin.readShort(data, offset);  offset += 2;
	obj.macStyle = bin.readUshort(data, offset);  offset += 2;
	obj.lowestRecPPEM = bin.readUshort(data, offset);  offset += 2;
	obj.fontDirectionHint = bin.readShort(data, offset);  offset += 2;
	obj.indexToLocFormat  = bin.readShort(data, offset);  offset += 2;
	obj.glyphDataFormat   = bin.readShort(data, offset);  offset += 2;
	return obj;
}


Typr.hhea = {};
Typr.hhea.parse = function(data, offset, length)
{
	var bin = Typr._bin;
	var obj = {};
	var tableVersion = bin.readFixed(data, offset);  offset += 4;
	obj.ascender  = bin.readShort(data, offset);  offset += 2;
	obj.descender = bin.readShort(data, offset);  offset += 2;
	obj.lineGap = bin.readShort(data, offset);  offset += 2;
	
	obj.advanceWidthMax = bin.readUshort(data, offset);  offset += 2;
	obj.minLeftSideBearing  = bin.readShort(data, offset);  offset += 2;
	obj.minRightSideBearing = bin.readShort(data, offset);  offset += 2;
	obj.xMaxExtent = bin.readShort(data, offset);  offset += 2;
	
	obj.caretSlopeRise = bin.readShort(data, offset);  offset += 2;
	obj.caretSlopeRun  = bin.readShort(data, offset);  offset += 2;
	obj.caretOffset    = bin.readShort(data, offset);  offset += 2;
	
	offset += 4*2;
	
	obj.metricDataFormat = bin.readShort (data, offset);  offset += 2;
	obj.numberOfHMetrics = bin.readUshort(data, offset);  offset += 2;
	return obj;
}


Typr.hmtx = {};
Typr.hmtx.parse = function(data, offset, length, font)
{
	var bin = Typr._bin;
	var obj = {};
	
	obj.aWidth = [];
	obj.lsBearing = [];
	
	
	var aw = 0, lsb = 0;
	
	for(var i=0; i<font.maxp.numGlyphs; i++)
	{
		if(i<font.hhea.numberOfHMetrics) {  aw=bin.readUshort(data, offset);  offset += 2;  lsb=bin.readShort(data, offset);  offset+=2;  }
		obj.aWidth.push(aw);
		obj.lsBearing.push(lsb);
	}
	
	return obj;
}


Typr.kern = {};
Typr.kern.parse = function(data, offset, length, font)
{
	var bin = Typr._bin;
	
	var version = bin.readUshort(data, offset);  offset+=2;
	if(version==1) return Typr.kern.parseV1(data, offset-2, length, font);
	var nTables = bin.readUshort(data, offset);  offset+=2;
	
	var map = {glyph1: [], rval:[]};
	for(var i=0; i<nTables; i++)
	{
		offset+=2;	// skip version
		var length  = bin.readUshort(data, offset);  offset+=2;
		var coverage = bin.readUshort(data, offset);  offset+=2;
		var format = coverage>>>8;
		/* I have seen format 128 once, that's why I do */ format &= 0xf;
		if(format==0) offset = Typr.kern.readFormat0(data, offset, map);
		else throw "unknown kern table format: "+format;
	}
	return map;
}

Typr.kern.parseV1 = function(data, offset, length, font)
{
	var bin = Typr._bin;
	
	var version = bin.readFixed(data, offset);  offset+=4;
	var nTables = bin.readUint(data, offset);  offset+=4;
	
	var map = {glyph1: [], rval:[]};
	for(var i=0; i<nTables; i++)
	{
		var length = bin.readUint(data, offset);   offset+=4;
		var coverage = bin.readUshort(data, offset);  offset+=2;
		var tupleIndex = bin.readUshort(data, offset);  offset+=2;
		var format = coverage>>>8;
		/* I have seen format 128 once, that's why I do */ format &= 0xf;
		if(format==0) offset = Typr.kern.readFormat0(data, offset, map);
		else throw "unknown kern table format: "+format;
	}
	return map;
}

Typr.kern.readFormat0 = function(data, offset, map)
{
	var bin = Typr._bin;
	var pleft = -1;
	var nPairs        = bin.readUshort(data, offset);  offset+=2;
	var searchRange   = bin.readUshort(data, offset);  offset+=2;
	var entrySelector = bin.readUshort(data, offset);  offset+=2;
	var rangeShift    = bin.readUshort(data, offset);  offset+=2;
	for(var j=0; j<nPairs; j++)
	{
		var left  = bin.readUshort(data, offset);  offset+=2;
		var right = bin.readUshort(data, offset);  offset+=2;
		var value = bin.readShort (data, offset);  offset+=2;
		if(left!=pleft) { map.glyph1.push(left);  map.rval.push({ glyph2:[], vals:[] }) }
		var rval = map.rval[map.rval.length-1];
		rval.glyph2.push(right);   rval.vals.push(value);
		pleft = left;
	}
	return offset;
}



Typr.loca = {};
Typr.loca.parse = function(data, offset, length, font)
{
	var bin = Typr._bin;
	var obj = [];
	
	var ver = font.head.indexToLocFormat;
	//console.log("loca", ver, length, 4*font.maxp.numGlyphs);
	var len = font.maxp.numGlyphs+1;
	
	if(ver==0) for(var i=0; i<len; i++) obj.push(bin.readUshort(data, offset+(i<<1))<<1);
	if(ver==1) for(var i=0; i<len; i++) obj.push(bin.readUint  (data, offset+(i<<2))   );
	
	return obj;
}


Typr.maxp = {};
Typr.maxp.parse = function(data, offset, length)
{
	//console.log(data.length, offset, length);
	
	var bin = Typr._bin;
	var obj = {};
	
	// both versions 0.5 and 1.0
	var ver = bin.readUint(data, offset); offset += 4;
	obj.numGlyphs = bin.readUshort(data, offset);  offset += 2;
	
	// only 1.0
	if(ver == 0x00010000)
	{
		obj.maxPoints             = bin.readUshort(data, offset);  offset += 2;
		obj.maxContours           = bin.readUshort(data, offset);  offset += 2;
		obj.maxCompositePoints    = bin.readUshort(data, offset);  offset += 2;
		obj.maxCompositeContours  = bin.readUshort(data, offset);  offset += 2;
		obj.maxZones              = bin.readUshort(data, offset);  offset += 2;
		obj.maxTwilightPoints     = bin.readUshort(data, offset);  offset += 2;
		obj.maxStorage            = bin.readUshort(data, offset);  offset += 2;
		obj.maxFunctionDefs       = bin.readUshort(data, offset);  offset += 2;
		obj.maxInstructionDefs    = bin.readUshort(data, offset);  offset += 2;
		obj.maxStackElements      = bin.readUshort(data, offset);  offset += 2;
		obj.maxSizeOfInstructions = bin.readUshort(data, offset);  offset += 2;
		obj.maxComponentElements  = bin.readUshort(data, offset);  offset += 2;
		obj.maxComponentDepth     = bin.readUshort(data, offset);  offset += 2;
	}
	
	return obj;
}


Typr.name = {};
Typr.name.parse = function(data, offset, length)
{
	var bin = Typr._bin;
	var obj = {};
	var format = bin.readUshort(data, offset);  offset += 2;
	var count  = bin.readUshort(data, offset);  offset += 2;
	var stringOffset = bin.readUshort(data, offset);  offset += 2;
	
	
	//console.log(format, count);
	
	var offset0 = offset;
	
	for(var i=0; i<count; i++)
	{
		var platformID = bin.readUshort(data, offset);  offset += 2;
		var encodingID = bin.readUshort(data, offset);  offset += 2;
		var languageID = bin.readUshort(data, offset);  offset += 2;
		var nameID     = bin.readUshort(data, offset);  offset += 2;
		var length     = bin.readUshort(data, offset);  offset += 2;
		var noffset    = bin.readUshort(data, offset);  offset += 2;
		//console.log(platformID, encodingID, languageID.toString(16), nameID, length, noffset);
		
		var plat = "p"+platformID;//Typr._platforms[platformID];
		if(obj[plat]==null) obj[plat] = {};
		
		var names = [
			"copyright",
			"fontFamily",
			"fontSubfamily",
			"ID",
			"fullName",
			"version",
			"postScriptName",
			"trademark",
			"manufacturer",
			"designer",
			"description",
			"urlVendor",
			"urlDesigner",
			"licence",
			"licenceURL",
			"---",
			"typoFamilyName",
			"typoSubfamilyName",
			"compatibleFull",
			"sampleText",
			"postScriptCID",
			"wwsFamilyName",
			"wwsSubfamilyName",
			"lightPalette",
			"darkPalette"
		];
		var cname = names[nameID];
		var soff = offset0 + count*12 + noffset;
		var str;
		if(false){}
		else if(platformID == 0) str = bin.readUnicode(data, soff, length/2);
		else if(platformID == 3 && encodingID == 0) str = bin.readUnicode(data, soff, length/2);
		else if(encodingID == 0) str = bin.readASCII  (data, soff, length);
		else if(encodingID == 1) str = bin.readUnicode(data, soff, length/2);
		else if(encodingID == 3) str = bin.readUnicode(data, soff, length/2);
		
		else if(platformID == 1) { str = bin.readASCII(data, soff, length);  console.log("reading unknown MAC encoding "+encodingID+" as ASCII") }
		else throw "unknown encoding "+encodingID + ", platformID: "+platformID;
		
		obj[plat][cname] = str;
		obj[plat]._lang = languageID;
	}
	/*
	if(format == 1)
	{
		var langTagCount = bin.readUshort(data, offset);  offset += 2;
		for(var i=0; i<langTagCount; i++)
		{
			var length  = bin.readUshort(data, offset);  offset += 2;
			var noffset = bin.readUshort(data, offset);  offset += 2;
		}
	}
	*/
	
	//console.log(obj);
	
	for(var p in obj) if(obj[p].postScriptName!=null && obj[p]._lang==0x0409) return obj[p];		// United States
	for(var p in obj) if(obj[p].postScriptName!=null && obj[p]._lang==0x0c0c) return obj[p];		// Canada
	for(var p in obj) if(obj[p].postScriptName!=null) return obj[p];
	
	var tname;
	for(var p in obj) { tname=p; break; }
	console.log("returning name table with languageID "+ obj[tname]._lang);
	return obj[tname];
}


Typr["OS/2"] = {};
Typr["OS/2"].parse = function(data, offset, length)
{
	var bin = Typr._bin;
	var ver = bin.readUshort(data, offset); offset += 2;
	
	var obj = {};
	if     (ver==0) Typr["OS/2"].version0(data, offset, obj);
	else if(ver==1) Typr["OS/2"].version1(data, offset, obj);
	else if(ver==2 || ver==3 || ver==4) Typr["OS/2"].version2(data, offset, obj);
	else if(ver==5) Typr["OS/2"].version5(data, offset, obj);
	else throw "unknown OS/2 table version: "+ver;
	
	return obj;
}

Typr["OS/2"].version0 = function(data, offset, obj)
{
	var bin = Typr._bin;
	obj.xAvgCharWidth = bin.readShort(data, offset); offset += 2;
	obj.usWeightClass = bin.readUshort(data, offset); offset += 2;
	obj.usWidthClass  = bin.readUshort(data, offset); offset += 2;
	obj.fsType = bin.readUshort(data, offset); offset += 2;
	obj.ySubscriptXSize = bin.readShort(data, offset); offset += 2;
	obj.ySubscriptYSize = bin.readShort(data, offset); offset += 2;
	obj.ySubscriptXOffset = bin.readShort(data, offset); offset += 2;
	obj.ySubscriptYOffset = bin.readShort(data, offset); offset += 2; 
	obj.ySuperscriptXSize = bin.readShort(data, offset); offset += 2; 
	obj.ySuperscriptYSize = bin.readShort(data, offset); offset += 2; 
	obj.ySuperscriptXOffset = bin.readShort(data, offset); offset += 2;
	obj.ySuperscriptYOffset = bin.readShort(data, offset); offset += 2;
	obj.yStrikeoutSize = bin.readShort(data, offset); offset += 2;
	obj.yStrikeoutPosition = bin.readShort(data, offset); offset += 2;
	obj.sFamilyClass = bin.readShort(data, offset); offset += 2;
	obj.panose = bin.readBytes(data, offset, 10);  offset += 10;
	obj.ulUnicodeRange1	= bin.readUint(data, offset);  offset += 4;
	obj.ulUnicodeRange2	= bin.readUint(data, offset);  offset += 4;
	obj.ulUnicodeRange3	= bin.readUint(data, offset);  offset += 4;
	obj.ulUnicodeRange4	= bin.readUint(data, offset);  offset += 4;
	obj.achVendID = [bin.readInt8(data, offset), bin.readInt8(data, offset+1),bin.readInt8(data, offset+2),bin.readInt8(data, offset+3)];  offset += 4;
	obj.fsSelection	 = bin.readUshort(data, offset); offset += 2;
	obj.usFirstCharIndex = bin.readUshort(data, offset); offset += 2;
	obj.usLastCharIndex = bin.readUshort(data, offset); offset += 2;
	obj.sTypoAscender = bin.readShort(data, offset); offset += 2;
	obj.sTypoDescender = bin.readShort(data, offset); offset += 2;
	obj.sTypoLineGap = bin.readShort(data, offset); offset += 2;
	obj.usWinAscent = bin.readUshort(data, offset); offset += 2;
	obj.usWinDescent = bin.readUshort(data, offset); offset += 2;
	return offset;
}

Typr["OS/2"].version1 = function(data, offset, obj)
{
	var bin = Typr._bin;
	offset = Typr["OS/2"].version0(data, offset, obj);
	
	obj.ulCodePageRange1 = bin.readUint(data, offset); offset += 4;
	obj.ulCodePageRange2 = bin.readUint(data, offset); offset += 4;
	return offset;
}

Typr["OS/2"].version2 = function(data, offset, obj)
{
	var bin = Typr._bin;
	offset = Typr["OS/2"].version1(data, offset, obj);
	
	obj.sxHeight = bin.readShort(data, offset); offset += 2;
	obj.sCapHeight = bin.readShort(data, offset); offset += 2;
	obj.usDefault = bin.readUshort(data, offset); offset += 2;
	obj.usBreak = bin.readUshort(data, offset); offset += 2;
	obj.usMaxContext = bin.readUshort(data, offset); offset += 2;
	return offset;
}

Typr["OS/2"].version5 = function(data, offset, obj)
{
	var bin = Typr._bin;
	offset = Typr["OS/2"].version2(data, offset, obj);

	obj.usLowerOpticalPointSize = bin.readUshort(data, offset); offset += 2;
	obj.usUpperOpticalPointSize = bin.readUshort(data, offset); offset += 2;
	return offset;
}

Typr.post = {};
Typr.post.parse = function(data, offset, length)
{
	var bin = Typr._bin;
	var obj = {};
	
	obj.version           = bin.readFixed(data, offset);  offset+=4;
	obj.italicAngle       = bin.readFixed(data, offset);  offset+=4;
	obj.underlinePosition = bin.readShort(data, offset);  offset+=2;
	obj.underlineThickness = bin.readShort(data, offset);  offset+=2;

	return obj;
}
Typr.SVG = {};
Typr.SVG.parse = function(data, offset, length)
{
	var bin = Typr._bin;
	var obj = { entries: []};

	var offset0 = offset;

	var tableVersion = bin.readUshort(data, offset);	offset += 2;
	var svgDocIndexOffset = bin.readUint(data, offset);	offset += 4;
	var reserved = bin.readUint(data, offset); offset += 4;

	offset = svgDocIndexOffset + offset0;

	var numEntries = bin.readUshort(data, offset);	offset += 2;

	for(var i=0; i<numEntries; i++)
	{
		var startGlyphID = bin.readUshort(data, offset);  offset += 2;
		var endGlyphID   = bin.readUshort(data, offset);  offset += 2;
		var svgDocOffset = bin.readUint  (data, offset);  offset += 4;
		var svgDocLength = bin.readUint  (data, offset);  offset += 4;

		var sbuf = new Uint8Array(data.buffer, offset0 + svgDocOffset + svgDocIndexOffset, svgDocLength);
		var svg = bin.readUTF8(sbuf, 0, sbuf.length);
		
		for(var f=startGlyphID; f<=endGlyphID; f++) {
			obj.entries[f] = svg;
		}
	}
	return obj;
}

Typr.SVG.toPath = function(str)
{
	var pth = {cmds:[], crds:[]};
	if(str==null) return pth;
	
	var prsr = new DOMParser();
	var doc = prsr["parseFromString"](str,"image/svg+xml");
	
	var svg = doc.firstChild;  while(svg.tagName!="svg") svg = svg.nextSibling;
	var vb = svg.getAttribute("viewBox");
	if(vb) vb = vb.trim().split(" ").map(parseFloat);  else   vb = [0,0,1000,1000];
	Typr.SVG._toPath(svg.children, pth);
	for(var i=0; i<pth.crds.length; i+=2) {
		var x = pth.crds[i], y = pth.crds[i+1];
		x -= vb[0];
		y -= vb[1];
		y = -y;
		pth.crds[i] = x;
		pth.crds[i+1] = y;
	}
	return pth;
}

Typr.SVG._toPath = function(nds, pth, fill) {
	for(var ni=0; ni<nds.length; ni++) {
		var nd = nds[ni], tn = nd.tagName;
		var cfl = nd.getAttribute("fill");  if(cfl==null) cfl = fill;
		if(tn=="g") Typr.SVG._toPath(nd.children, pth, cfl);
		else if(tn=="path") {
			pth.cmds.push(cfl?cfl:"#000000");
			var d = nd.getAttribute("d");  //console.log(d);
			var toks = Typr.SVG._tokens(d);  //console.log(toks);
			Typr.SVG._toksToPath(toks, pth);  pth.cmds.push("X");
		}
		else if(tn=="defs") {}
		else console.log(tn, nd);
	}
}

Typr.SVG._tokens = function(d) {
	var ts = [], off = 0, rn=false, cn="";  // reading number, current number
	while(off<d.length){
		var cc=d.charCodeAt(off), ch = d.charAt(off);  off++;
		var isNum = (48<=cc && cc<=57) || ch=="." || ch=="-";
		
		if(rn) {
			if(ch=="-") {  ts.push(parseFloat(cn));  cn=ch;  }
			else if(isNum) cn+=ch;
			else {  ts.push(parseFloat(cn));  if(ch!="," && ch!=" ") ts.push(ch);  rn=false;  }
		}
		else {
			if(isNum) {  cn=ch;  rn=true;  }
			else if(ch!="," && ch!=" ") ts.push(ch);
		}
	}
	if(rn) ts.push(parseFloat(cn));
	return ts;
}

Typr.SVG._toksToPath = function(ts, pth) {	
	var i = 0, x = 0, y = 0, ox = 0, oy = 0;
	var pc = {"M":2,"L":2,"H":1,"V":1,   "S":4,   "C":6};
	var cmds = pth.cmds, crds = pth.crds;
	
	while(i<ts.length) {
		var cmd = ts[i];  i++;
		
		if(cmd=="z") {  cmds.push("Z");  x=ox;  y=oy;  }
		else {
			var cmu = cmd.toUpperCase();
			var ps = pc[cmu], reps = Typr.SVG._reps(ts, i, ps);
		
			for(var j=0; j<reps; j++) {
				var xi = 0, yi = 0;   if(cmd!=cmu) {  xi=x;  yi=y;  }
				
				if(false) {}
				else if(cmu=="M") {  x = xi+ts[i++];  y = yi+ts[i++];  cmds.push("M");  crds.push(x,y);  ox=x;  oy=y; }
				else if(cmu=="L") {  x = xi+ts[i++];  y = yi+ts[i++];  cmds.push("L");  crds.push(x,y);  }
				else if(cmu=="H") {  x = xi+ts[i++];                   cmds.push("L");  crds.push(x,y);  }
				else if(cmu=="V") {  y = yi+ts[i++];                   cmds.push("L");  crds.push(x,y);  }
				else if(cmu=="C") {
					var x1=xi+ts[i++], y1=yi+ts[i++], x2=xi+ts[i++], y2=yi+ts[i++], x3=xi+ts[i++], y3=yi+ts[i++];
					cmds.push("C");  crds.push(x1,y1,x2,y2,x3,y3);  x=x3;  y=y3;
				}
				else if(cmu=="S") {
					var co = Math.max(crds.length-4, 0);
					var x1 = x+x-crds[co], y1 = y+y-crds[co+1];
					var x2=xi+ts[i++], y2=yi+ts[i++], x3=xi+ts[i++], y3=yi+ts[i++];  
					cmds.push("C");  crds.push(x1,y1,x2,y2,x3,y3);  x=x3;  y=y3;
				}
				else console.log("Unknown SVG command "+cmd);
			}
		}
	}
}
Typr.SVG._reps = function(ts, off, ps) {
	var i = off;
	while(i<ts.length) {  if((typeof ts[i]) == "string") break;  i+=ps;  }
	return (i-off)/ps;
}
if(Typr  ==null) Typr   = {};
if(Typr.U==null) Typr.U = {};


Typr.U.codeToGlyph = function(font, code)
{
	var cmap = font.cmap;
	
	var tind = -1;
	if(cmap.p0e4!=null) tind = cmap.p0e4;
	else if(cmap.p3e1!=null) tind = cmap.p3e1;
	else if(cmap.p1e0!=null) tind = cmap.p1e0;
	
	if(tind==-1) throw "no familiar platform and encoding!";
	
	var tab = cmap.tables[tind];
	
	if(tab.format==0)
	{
		if(code>=tab.map.length) return 0;
		return tab.map[code];
	}
	else if(tab.format==4)
	{
		var sind = -1;
		for(var i=0; i<tab.endCount.length; i++)   if(code<=tab.endCount[i]){  sind=i;  break;  } 
		if(sind==-1) return 0;
		if(tab.startCount[sind]>code) return 0;
		
		var gli = 0;
		if(tab.idRangeOffset[sind]!=0) gli = tab.glyphIdArray[(code-tab.startCount[sind]) + (tab.idRangeOffset[sind]>>1) - (tab.idRangeOffset.length-sind)];
		else                           gli = code + tab.idDelta[sind];
		return gli & 0xFFFF;
	}
	else if(tab.format==12)
	{
		if(code>tab.groups[tab.groups.length-1][1]) return 0;
		for(var i=0; i<tab.groups.length; i++)
		{
			var grp = tab.groups[i];
			if(grp[0]<=code && code<=grp[1]) return grp[2] + (code-grp[0]);
		}
		return 0;
	}
	else throw "unknown cmap table format "+tab.format;
}


Typr.U.glyphToPath = function(font, gid)
{
	var path = { cmds:[], crds:[] };
	if(font.SVG && font.SVG.entries[gid]) {
		var p = font.SVG.entries[gid];  if(p==null) return path;
		if(typeof p == "string") {  p = Typr.SVG.toPath(p);  font.SVG.entries[gid]=p;  }
		return p;
	}
	else if(font.CFF) {
		var state = {x:0,y:0,stack:[],nStems:0,haveWidth:false,width: font.CFF.Private ? font.CFF.Private.defaultWidthX : 0,open:false};
		Typr.U._drawCFF(font.CFF.CharStrings[gid], state, font.CFF, path);
	}
	else if(font.glyf) {  Typr.U._drawGlyf(gid, font, path);  }
	return path;
}

Typr.U._drawGlyf = function(gid, font, path)
{
	var gl = font.glyf[gid];
	if(gl==null) gl = font.glyf[gid] = Typr.glyf._parseGlyf(font, gid);
	if(gl!=null){
		if(gl.noc>-1) Typr.U._simpleGlyph(gl, path);
		else          Typr.U._compoGlyph (gl, font, path);
	}
}
Typr.U._simpleGlyph = function(gl, p)
{
	for(var c=0; c<gl.noc; c++)
	{
		var i0 = (c==0) ? 0 : (gl.endPts[c-1] + 1);
		var il = gl.endPts[c];
		
		for(var i=i0; i<=il; i++)
		{
			var pr = (i==i0)?il:(i-1);
			var nx = (i==il)?i0:(i+1);
			var onCurve = gl.flags[i]&1;
			var prOnCurve = gl.flags[pr]&1;
			var nxOnCurve = gl.flags[nx]&1;
			
			var x = gl.xs[i], y = gl.ys[i];
			
			if(i==i0) { 
				if(onCurve)  
				{
					if(prOnCurve) Typr.U.P.moveTo(p, gl.xs[pr], gl.ys[pr]); 
					else          {  Typr.U.P.moveTo(p,x,y);  continue;  /*  will do curveTo at il  */  }
				}
				else        
				{
					if(prOnCurve) Typr.U.P.moveTo(p,  gl.xs[pr],       gl.ys[pr]        );
					else          Typr.U.P.moveTo(p, (gl.xs[pr]+x)/2, (gl.ys[pr]+y)/2   ); 
				}
			}
			if(onCurve)
			{
				if(prOnCurve) Typr.U.P.lineTo(p,x,y);
			}
			else
			{
				if(nxOnCurve) Typr.U.P.qcurveTo(p, x, y, gl.xs[nx], gl.ys[nx]); 
				else          Typr.U.P.qcurveTo(p, x, y, (x+gl.xs[nx])/2, (y+gl.ys[nx])/2); 
			}
		}
		Typr.U.P.closePath(p);
	}
}
Typr.U._compoGlyph = function(gl, font, p)
{
	for(var j=0; j<gl.parts.length; j++)
	{
		var path = { cmds:[], crds:[] };
		var prt = gl.parts[j];
		Typr.U._drawGlyf(prt.glyphIndex, font, path);
		
		var m = prt.m;
		for(var i=0; i<path.crds.length; i+=2)
		{
			var x = path.crds[i  ], y = path.crds[i+1];
			p.crds.push(x*m.a + y*m.b + m.tx);
			p.crds.push(x*m.c + y*m.d + m.ty);
		}
		for(var i=0; i<path.cmds.length; i++) p.cmds.push(path.cmds[i]);
	}
}


Typr.U._getGlyphClass = function(g, cd)
{
	var intr = Typr._lctf.getInterval(cd, g);
	return intr==-1 ? 0 : cd[intr+2];
	//for(var i=0; i<cd.start.length; i++) 
	//	if(cd.start[i]<=g && cd.end[i]>=g) return cd.class[i];
	//return 0;
}

Typr.U.getPairAdjustment = function(font, g1, g2)
{
	if(font.GPOS)
	{
		var ltab = null;
		for(var i=0; i<font.GPOS.featureList.length; i++) 
		{
			var fl = font.GPOS.featureList[i];
			if(fl.tag=="kern")
				for(var j=0; j<fl.tab.length; j++) 
					if(font.GPOS.lookupList[fl.tab[j]].ltype==2) ltab=font.GPOS.lookupList[fl.tab[j]];
		}
		if(ltab)
		{
			var adjv = 0;
			for(var i=0; i<ltab.tabs.length; i++)
			{
				var tab = ltab.tabs[i];
				var ind = Typr._lctf.coverageIndex(tab.coverage, g1);
				if(ind==-1) continue;
				var adj;
				if(tab.format==1)
				{
					var right = tab.pairsets[ind];
					for(var j=0; j<right.length; j++) if(right[j].gid2==g2) adj = right[j];
					if(adj==null) continue;
				}
				else if(tab.format==2)
				{
					var c1 = Typr.U._getGlyphClass(g1, tab.classDef1);
					var c2 = Typr.U._getGlyphClass(g2, tab.classDef2);
					var adj = tab.matrix[c1][c2];
				}
				return adj.val1[2];
			}
		}
	}
	if(font.kern)
	{
		var ind1 = font.kern.glyph1.indexOf(g1);
		if(ind1!=-1)
		{
			var ind2 = font.kern.rval[ind1].glyph2.indexOf(g2);
			if(ind2!=-1) return font.kern.rval[ind1].vals[ind2];
		}
	}
	
	return 0;
}

Typr.U.stringToGlyphs = function(font, str)
{
	var gls = [];
	for(var i=0; i<str.length; i++) {
		var cc = str.codePointAt(i);  if(cc>0xffff) i++;
		gls.push(Typr.U.codeToGlyph(font, cc));
	}
	//console.log(gls.slice(0));
	
	//console.log(gls);  return gls;
	
	var gsub = font["GSUB"];  if(gsub==null) return gls;
	var llist = gsub.lookupList, flist = gsub.featureList;
	
	var wsep = "\n\t\" ,.:;!?()  ،";
	var R = "آأؤإاةدذرزوٱٲٳٵٶٷڈډڊڋڌڍڎڏڐڑڒړڔڕږڗژڙۀۃۄۅۆۇۈۉۊۋۍۏےۓەۮۯܐܕܖܗܘܙܞܨܪܬܯݍݙݚݛݫݬݱݳݴݸݹࡀࡆࡇࡉࡔࡧࡩࡪࢪࢫࢬࢮࢱࢲࢹૅેૉ૊૎૏ૐ૑૒૝ૡ૤૯஁ஃ஄அஉ஌எஏ஑னப஫஬";
	var L = "ꡲ્૗";
	
	for(var ci=0; ci<gls.length; ci++) {
		var gl = gls[ci];
		
		var slft = ci==0            || wsep.indexOf(str[ci-1])!=-1;
		var srgt = ci==gls.length-1 || wsep.indexOf(str[ci+1])!=-1;
		
		if(!slft && R.indexOf(str[ci-1])!=-1) slft=true;
		if(!srgt && R.indexOf(str[ci  ])!=-1) srgt=true;
		
		if(!srgt && L.indexOf(str[ci+1])!=-1) srgt=true;
		if(!slft && L.indexOf(str[ci  ])!=-1) slft=true;
		
		var feat = null;
		if(slft) feat = srgt ? "isol" : "init";
		else     feat = srgt ? "fina" : "medi";
		
		for(var fi=0; fi<flist.length; fi++)
		{
			if(flist[fi].tag!=feat) continue;
			for(var ti=0; ti<flist[fi].tab.length; ti++)
			{
				var tab = llist[flist[fi].tab[ti]];
				if(tab.ltype!=1) continue;
				Typr.U._applyType1(gls, ci, tab);
			}
		}
	}
	var cligs = ["rlig", "liga", "mset"];
	
	//console.log(gls);
	
	for(var ci=0; ci<gls.length; ci++) {
		var gl = gls[ci];
		var rlim = Math.min(3, gls.length-ci-1);
		for(var fi=0; fi<flist.length; fi++)
		{
			var fl = flist[fi];  if(cligs.indexOf(fl.tag)==-1) continue;
			for(var ti=0; ti<fl.tab.length; ti++)
			{
				var tab = llist[fl.tab[ti]];
				for(var j=0; j<tab.tabs.length; j++)
				{
					if(tab.tabs[j]==null) continue;
					var ind = Typr._lctf.coverageIndex(tab.tabs[j].coverage, gl);  if(ind==-1) continue;  
					//*
					if(tab.ltype==4) {
						var vals = tab.tabs[j].vals[ind];
						
						for(var k=0; k<vals.length; k++) {
							var lig = vals[k], rl = lig.chain.length;  if(rl>rlim) continue;
							var good = true;
							for(var l=0; l<rl; l++) if(lig.chain[l]!=gls[ci+(1+l)]) good=false;
							if(!good) continue;
							gls[ci]=lig.nglyph;
							for(var l=0; l<rl; l++) gls[ci+l+1]=-1;
							//console.log("lig", fl.tag,  gl, lig.chain, lig.nglyph);
						}
					}
					else  if(tab.ltype==5) {
						var ltab = tab.tabs[j];  if(ltab.fmt!=2) continue;
						var cind = Typr._lctf.getInterval(ltab.cDef, gl);
						var cls = ltab.cDef[cind+2], scs = ltab.scset[cls]; 
						for(var i=0; i<scs.length; i++) {
							var sc = scs[i], inp = sc.input;
							if(inp.length>rlim) continue;
							var good = true;
							for(var l=0; l<inp.length; l++) {
								var cind2 = Typr._lctf.getInterval(ltab.cDef, gls[ci+1+l]);
								if(cind==-1 && ltab.cDef[cind2+2]!=inp[l]) {  good=false;  break;  }
							}
							if(!good) continue;
							//console.log(ci, gl);
							var lrs = sc.substLookupRecords;
							for(var k=0; k<lrs.length; k+=2)
							{
								var gi = lrs[k], tabi = lrs[k+1];
								//Typr.U._applyType1(gls, ci+gi, llist[tabi]);
								//console.log(tabi, gls[ci+gi], llist[tabi]);
							}
						}
					}
				}
			}
		}
	}
	
	return gls;
}
Typr.U._applyType1 = function(gls, ci, tab) {
	var gl = gls[ci];
	for(var j=0; j<tab.tabs.length; j++) {
		var ttab = tab.tabs[j];
		var ind = Typr._lctf.coverageIndex(ttab.coverage,gl);  if(ind==-1) continue;  
		if(ttab.fmt==1) gls[ci] = gls[ci]+ttab.delta;
		else            gls[ci] = ttab.newg[ind];
		//console.log(ci, gl, "subst", flist[fi].tag, i, j, ttab.newg[ind]);
	}
}

Typr.U.glyphsToPath = function(font, gls, clr)
{	
	//gls = gls.reverse();//gls.slice(0,12).concat(gls.slice(12).reverse());
	
	var tpath = {cmds:[], crds:[]};
	var x = 0;
	
	for(var i=0; i<gls.length; i++)
	{
		var gid = gls[i];  if(gid==-1) continue;
		var gid2 = (i<gls.length-1 && gls[i+1]!=-1)  ? gls[i+1] : 0;
		var path = Typr.U.glyphToPath(font, gid);
		for(var j=0; j<path.crds.length; j+=2)
		{
			tpath.crds.push(path.crds[j] + x);
			tpath.crds.push(path.crds[j+1]);
		}
		if(clr) tpath.cmds.push(clr);
		for(var j=0; j<path.cmds.length; j++) tpath.cmds.push(path.cmds[j]);
		if(clr) tpath.cmds.push("X");
		x += font.hmtx.aWidth[gid];// - font.hmtx.lsBearing[gid];
		if(i<gls.length-1) x += Typr.U.getPairAdjustment(font, gid, gid2);
	}
	return tpath;
}

Typr.U.pathToSVG = function(path, prec)
{
	if(prec==null) prec = 5;
	var out = [], co = 0, lmap = {"M":2,"L":2,"Q":4,"C":6};
	for(var i=0; i<path.cmds.length; i++)
	{
		var cmd = path.cmds[i], cn = co+(lmap[cmd]?lmap[cmd]:0);  
		out.push(cmd);
		while(co<cn) {  var c = path.crds[co++];  out.push(parseFloat(c.toFixed(prec))+(co==cn?"":" "));  }
	}
	return out.join("");
}

Typr.U.pathToContext = function(path, ctx)
{
	var c = 0, crds = path.crds;
	
	for(var j=0; j<path.cmds.length; j++)
	{
		var cmd = path.cmds[j];
		if     (cmd=="M") {
			ctx.moveTo(crds[c], crds[c+1]);
			c+=2;
		}
		else if(cmd=="L") {
			ctx.lineTo(crds[c], crds[c+1]);
			c+=2;
		}
		else if(cmd=="C") {
			ctx.bezierCurveTo(crds[c], crds[c+1], crds[c+2], crds[c+3], crds[c+4], crds[c+5]);
			c+=6;
		}
		else if(cmd=="Q") {
			ctx.quadraticCurveTo(crds[c], crds[c+1], crds[c+2], crds[c+3]);
			c+=4;
		}
		else if(cmd.charAt(0)=="#") {
			ctx.beginPath();
			ctx.fillStyle = cmd;
		}
		else if(cmd=="Z") {
			ctx.closePath();
		}
		else if(cmd=="X") {
			ctx.fill();
		}
	}
}


Typr.U.P = {};
Typr.U.P.moveTo = function(p, x, y)
{
	p.cmds.push("M");  p.crds.push(x,y);
}
Typr.U.P.lineTo = function(p, x, y)
{
	p.cmds.push("L");  p.crds.push(x,y);
}
Typr.U.P.curveTo = function(p, a,b,c,d,e,f)
{
	p.cmds.push("C");  p.crds.push(a,b,c,d,e,f);
}
Typr.U.P.qcurveTo = function(p, a,b,c,d)
{
	p.cmds.push("Q");  p.crds.push(a,b,c,d);
}
Typr.U.P.closePath = function(p) {  p.cmds.push("Z");  }




Typr.U._drawCFF = function(cmds, state, font, p)
{
	var stack = state.stack;
	var nStems = state.nStems, haveWidth=state.haveWidth, width=state.width, open=state.open;
	var i=0;
	var x=state.x, y=state.y, c1x=0, c1y=0, c2x=0, c2y=0, c3x=0, c3y=0, c4x=0, c4y=0, jpx=0, jpy=0;
	
	var o = {val:0,size:0};
	//console.log(cmds);
	while(i<cmds.length)
	{
		Typr.CFF.getCharString(cmds, i, o);
		var v = o.val;
		i += o.size;
			
		if(false) {}
		else if(v=="o1" || v=="o18")  //  hstem || hstemhm
		{
			var hasWidthArg;

			// The number of stem operators on the stack is always even.
			// If the value is uneven, that means a width is specified.
			hasWidthArg = stack.length % 2 !== 0;
			if (hasWidthArg && !haveWidth) {
				width = stack.shift() + font.Private.nominalWidthX;
			}

			nStems += stack.length >> 1;
			stack.length = 0;
			haveWidth = true;
		}
		else if(v=="o3" || v=="o23")  // vstem || vstemhm
		{
			var hasWidthArg;

			// The number of stem operators on the stack is always even.
			// If the value is uneven, that means a width is specified.
			hasWidthArg = stack.length % 2 !== 0;
			if (hasWidthArg && !haveWidth) {
				width = stack.shift() + font.Private.nominalWidthX;
			}

			nStems += stack.length >> 1;
			stack.length = 0;
			haveWidth = true;
		}
		else if(v=="o4")
		{
			if (stack.length > 1 && !haveWidth) {
                        width = stack.shift() + font.Private.nominalWidthX;
                        haveWidth = true;
                    }
			if(open) Typr.U.P.closePath(p);

                    y += stack.pop();
					Typr.U.P.moveTo(p,x,y);   open=true;
		}
		else if(v=="o5")
		{
			while (stack.length > 0) {
                        x += stack.shift();
                        y += stack.shift();
                        Typr.U.P.lineTo(p, x, y);
                    }
		}
		else if(v=="o6" || v=="o7")  // hlineto || vlineto
		{
			var count = stack.length;
			var isX = (v == "o6");
			
			for(var j=0; j<count; j++) {
				var sval = stack.shift();
				
				if(isX) x += sval;  else  y += sval;
				isX = !isX;
				Typr.U.P.lineTo(p, x, y);
			}
		}
		else if(v=="o8" || v=="o24")	// rrcurveto || rcurveline
		{
			var count = stack.length;
			var index = 0;
			while(index+6 <= count) {
				c1x = x + stack.shift();
				c1y = y + stack.shift();
				c2x = c1x + stack.shift();
				c2y = c1y + stack.shift();
				x = c2x + stack.shift();
				y = c2y + stack.shift();
				Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, x, y);
				index+=6;
			}
			if(v=="o24")
			{
				x += stack.shift();
				y += stack.shift();
				Typr.U.P.lineTo(p, x, y);
			}
		}
		else if(v=="o11")  break;
		else if(v=="o1234" || v=="o1235" || v=="o1236" || v=="o1237")//if((v+"").slice(0,3)=="o12")
		{
			if(v=="o1234")
			{
				c1x = x   + stack.shift();    // dx1
                c1y = y;                      // dy1
				c2x = c1x + stack.shift();    // dx2
				c2y = c1y + stack.shift();    // dy2
				jpx = c2x + stack.shift();    // dx3
				jpy = c2y;                    // dy3
				c3x = jpx + stack.shift();    // dx4
				c3y = c2y;                    // dy4
				c4x = c3x + stack.shift();    // dx5
				c4y = y;                      // dy5
				x = c4x + stack.shift();      // dx6
				Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, jpx, jpy);
				Typr.U.P.curveTo(p, c3x, c3y, c4x, c4y, x, y);
				
			}
			if(v=="o1235")
			{
				c1x = x   + stack.shift();    // dx1
				c1y = y   + stack.shift();    // dy1
				c2x = c1x + stack.shift();    // dx2
				c2y = c1y + stack.shift();    // dy2
				jpx = c2x + stack.shift();    // dx3
				jpy = c2y + stack.shift();    // dy3
				c3x = jpx + stack.shift();    // dx4
				c3y = jpy + stack.shift();    // dy4
				c4x = c3x + stack.shift();    // dx5
				c4y = c3y + stack.shift();    // dy5
				x = c4x + stack.shift();      // dx6
				y = c4y + stack.shift();      // dy6
				stack.shift();                // flex depth
				Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, jpx, jpy);
				Typr.U.P.curveTo(p, c3x, c3y, c4x, c4y, x, y);
			}
			if(v=="o1236")
			{
				c1x = x   + stack.shift();    // dx1
				c1y = y   + stack.shift();    // dy1
				c2x = c1x + stack.shift();    // dx2
				c2y = c1y + stack.shift();    // dy2
				jpx = c2x + stack.shift();    // dx3
				jpy = c2y;                    // dy3
				c3x = jpx + stack.shift();    // dx4
				c3y = c2y;                    // dy4
				c4x = c3x + stack.shift();    // dx5
				c4y = c3y + stack.shift();    // dy5
				x = c4x + stack.shift();      // dx6
				Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, jpx, jpy);
				Typr.U.P.curveTo(p, c3x, c3y, c4x, c4y, x, y);
			}
			if(v=="o1237")
			{
				c1x = x   + stack.shift();    // dx1
				c1y = y   + stack.shift();    // dy1
				c2x = c1x + stack.shift();    // dx2
				c2y = c1y + stack.shift();    // dy2
				jpx = c2x + stack.shift();    // dx3
				jpy = c2y + stack.shift();    // dy3
				c3x = jpx + stack.shift();    // dx4
				c3y = jpy + stack.shift();    // dy4
				c4x = c3x + stack.shift();    // dx5
				c4y = c3y + stack.shift();    // dy5
				if (Math.abs(c4x - x) > Math.abs(c4y - y)) {
				    x = c4x + stack.shift();
				} else {
				    y = c4y + stack.shift();
				}
				Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, jpx, jpy);
				Typr.U.P.curveTo(p, c3x, c3y, c4x, c4y, x, y);
			}
		}
		else if(v=="o14")
		{
			if (stack.length > 0 && !haveWidth) {
                        width = stack.shift() + font.nominalWidthX;
                        haveWidth = true;
                    }
			if(stack.length==4) // seac = standard encoding accented character
			{
			
				var asb = 0;
				var adx = stack.shift();
				var ady = stack.shift();
				var bchar = stack.shift();
				var achar = stack.shift();
			
				
				var bind = Typr.CFF.glyphBySE(font, bchar);
				var aind = Typr.CFF.glyphBySE(font, achar);
				
				//console.log(bchar, bind);
				//console.log(achar, aind);
				//state.x=x; state.y=y; state.nStems=nStems; state.haveWidth=haveWidth; state.width=width;  state.open=open;
				
				Typr.U._drawCFF(font.CharStrings[bind], state,font,p);
				state.x = adx; state.y = ady;
				Typr.U._drawCFF(font.CharStrings[aind], state,font,p);
				
				//x=state.x; y=state.y; nStems=state.nStems; haveWidth=state.haveWidth; width=state.width;  open=state.open;
			}
			if(open) {  Typr.U.P.closePath(p);  open=false;  }
		}		
		else if(v=="o19" || v=="o20") 
		{ 
			var hasWidthArg;

			// The number of stem operators on the stack is always even.
			// If the value is uneven, that means a width is specified.
			hasWidthArg = stack.length % 2 !== 0;
			if (hasWidthArg && !haveWidth) {
				width = stack.shift() + font.Private.nominalWidthX;
			}

			nStems += stack.length >> 1;
			stack.length = 0;
			haveWidth = true;
			
			i += (nStems + 7) >> 3;
		}
		
		else if(v=="o21") {
			if (stack.length > 2 && !haveWidth) {
                        width = stack.shift() + font.Private.nominalWidthX;
                        haveWidth = true;
                    }

                    y += stack.pop();
                    x += stack.pop();
					
					if(open) Typr.U.P.closePath(p);
                    Typr.U.P.moveTo(p,x,y);   open=true;
		}
		else if(v=="o22")
		{
			 if (stack.length > 1 && !haveWidth) {
                        width = stack.shift() + font.Private.nominalWidthX;
                        haveWidth = true;
                    }
					
                    x += stack.pop();
					
					if(open) Typr.U.P.closePath(p);
					Typr.U.P.moveTo(p,x,y);   open=true;                    
		}
		else if(v=="o25")
		{
			while (stack.length > 6) {
                        x += stack.shift();
                        y += stack.shift();
                        Typr.U.P.lineTo(p, x, y);
                    }

                    c1x = x + stack.shift();
                    c1y = y + stack.shift();
                    c2x = c1x + stack.shift();
                    c2y = c1y + stack.shift();
                    x = c2x + stack.shift();
                    y = c2y + stack.shift();
                    Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, x, y);
		}
		else if(v=="o26") 
		{
			if (stack.length % 2) {
                        x += stack.shift();
                    }

                    while (stack.length > 0) {
                        c1x = x;
                        c1y = y + stack.shift();
                        c2x = c1x + stack.shift();
                        c2y = c1y + stack.shift();
                        x = c2x;
                        y = c2y + stack.shift();
                        Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, x, y);
                    }

		}
		else if(v=="o27")
		{
			if (stack.length % 2) {
                        y += stack.shift();
                    }

                    while (stack.length > 0) {
                        c1x = x + stack.shift();
                        c1y = y;
                        c2x = c1x + stack.shift();
                        c2y = c1y + stack.shift();
                        x = c2x + stack.shift();
                        y = c2y;
                        Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, x, y);
                    }
		}
		else if(v=="o10" || v=="o29")	// callsubr || callgsubr
		{
			var obj = (v=="o10" ? font.Private : font);
			if(stack.length==0) { console.log("error: empty stack");  }
			else {
				var ind = stack.pop();
				var subr = obj.Subrs[ ind + obj.Bias ];
				state.x=x; state.y=y; state.nStems=nStems; state.haveWidth=haveWidth; state.width=width;  state.open=open;
				Typr.U._drawCFF(subr, state,font,p);
				x=state.x; y=state.y; nStems=state.nStems; haveWidth=state.haveWidth; width=state.width;  open=state.open;
			}
		}
		else if(v=="o30" || v=="o31")   // vhcurveto || hvcurveto
		{
			var count, count1 = stack.length;
			var index = 0;
			var alternate = v == "o31";
			
			count  = count1 & ~2;
			index += count1 - count;
			
			while ( index < count ) 
			{
				if(alternate)
				{
					c1x = x + stack.shift();
					c1y = y;
					c2x = c1x + stack.shift();
					c2y = c1y + stack.shift();
					y = c2y + stack.shift();
					if(count-index == 5) {  x = c2x + stack.shift();  index++;  }
					else x = c2x;
					alternate = false;
				}
				else
				{
					c1x = x;
					c1y = y + stack.shift();
					c2x = c1x + stack.shift();
					c2y = c1y + stack.shift();
					x = c2x + stack.shift();
					if(count-index == 5) {  y = c2y + stack.shift();  index++;  }
					else y = c2y;
					alternate = true;
				}
                Typr.U.P.curveTo(p, c1x, c1y, c2x, c2y, x, y);
				index += 4;
			}
		}
		
		else if((v+"").charAt(0)=="o") {   console.log("Unknown operation: "+v, cmds); throw v;  }
		else stack.push(v);
	}
	//console.log(cmds);
	state.x=x; state.y=y; state.nStems=nStems; state.haveWidth=haveWidth; state.width=width; state.open=open;
}

var UZIP = {};


UZIP.parse = function(data)	// Uint8Array
{
	var bin = UZIP.bin, offset = 0, out = {};
	
	var eocd = data.length-4;
	
	while(bin.readUint(data, eocd)!=0x06054b50) eocd--;
	
	var offset = eocd;
	offset+=4;	// sign  = 0x06054b50
	offset+=4;  // disks = 0;
	var cnu = bin.readUshort(data, offset);  offset+=2;
	var cnt = bin.readUshort(data, offset);  offset+=2;
			
	var csize = bin.readUint  (data, offset);  offset+=4;
	var coffs = bin.readUint  (data, offset);  offset+=4;
	
	offset = coffs;
	for(var i=0; i<cnu; i++)
	{
		var sign = bin.readUint(data, offset);  offset+=4;
		offset += 4;  // versions;
		offset += 4;  // flag + compr
		offset += 4;  // time
		
		var crc = bin.readUint(data, offset);  offset+=4;
		offset += 8;  // sizes
		var nl = bin.readUshort(data, offset), el = bin.readUshort(data, offset+2), cl = bin.readUshort(data, offset+4);  offset += 6;  // name, extra, comment
		offset += 8;  // disk, attribs
		
		var roff = bin.readUint(data, offset);  offset+=4;
		offset += nl + el + cl;
		
		UZIP._readLocal(data, roff, out);
	}
	//console.log(out);
	return out;
}

UZIP._readLocal = function(data, offset, out)
{
	var bin = UZIP.bin;
	var sign = bin.readUint(data, offset);  offset+=4;
	var ver   = bin.readUshort(data, offset);  offset+=2;
	var gpflg = bin.readUshort(data, offset);  offset+=2;
	//if((gpflg&8)!=0) throw "unknown sizes";
	var cmpr  = bin.readUshort(data, offset);  offset+=2;
	
	var time  = bin.readUint(data, offset);  offset+=4;
	
			
	var crc32 = bin.readUint  (data, offset);  offset+=4;
	var csize = bin.readUint  (data, offset);  offset+=4;
	var usize = bin.readUint  (data, offset);  offset+=4;
		
	var nlen  = bin.readUshort(data, offset);  offset+=2;
	var elen  = bin.readUshort(data, offset);  offset+=2;
		
	var name =  bin.readASCII(data, offset, nlen);  offset+=nlen;
	offset += elen;
			
	//console.log(ver, gpflg, cmpr, crc32, csize, usize, nlen, elen, name);
			
	var file = new Uint8Array(data.buffer, offset);
	if(false) {}
	else if(cmpr==0) out[name] = new Uint8Array(file.buffer.slice(offset, offset+csize));
	else if(cmpr==8) out[name] = pako["inflateRaw"](file);
	else throw "unknown compression method: "+cmpr;
}




UZIP.encode = function(obj) {
	var tot = 0;
	for(var p in obj) tot += obj[p].length + 30 + p.length + 46 + p.length;
	tot +=  22;
	
	var data = new Uint8Array(tot), offset = 0, bin = UZIP.bin;
	var fof = []
	
	for(var p in obj) {
		var file = obj[p];  fof.push(offset);
		offset = UZIP._writeHeader(data, offset, p, file, 0);
	}
	var i=0, ioff = offset;
	for(var p in obj) {
		var file = obj[p];  fof.push(offset);
		offset = UZIP._writeHeader(data, offset, p, file, 1, fof[i++]);		
	}
	var csize = offset-ioff;
	
	bin.writeUint  (data, offset, 0x06054b50);  offset+=4;
	offset += 4;  // disks
	bin.writeUshort(data, offset, i);  offset += 2;
	bin.writeUshort(data, offset, i);  offset += 2;	// number of c d records
	bin.writeUint  (data, offset, csize);  offset += 4;
	bin.writeUint  (data, offset, ioff );  offset += 4;
	offset += 2;
	
	return data;
}

UZIP._writeHeader = function(data, offset, p, file, t, roff)
{
	var bin = UZIP.bin;
	
	bin.writeUint  (data, offset, t==0 ? 0x04034b50 : 0x02014b50);  offset+=4; // sign
	if(t==1) offset+=2;  // ver made by
	bin.writeUshort(data, offset, 20);  offset+=2;	// ver
	bin.writeUshort(data, offset, 0);  offset+=2;   // gflip
	bin.writeUshort(data, offset, 0);  offset+=2;	// cmpr
		
	bin.writeUint(data, offset, 0);  offset+=4;	// time		
	bin.writeUint(data, offset, UZIP.crc.crc(file,0,file.length));  offset+=4;	// crc32
	bin.writeUint(data, offset, file.length);  offset+=4;	// csize
	bin.writeUint(data, offset, file.length);  offset+=4;	// usize
		
	bin.writeUshort(data, offset, p.length);  offset+=2;	// nlen
	bin.writeUshort(data, offset, 0);  offset+=2;	// elen
	
	if(t==1) {
		offset += 2;  // comment length
		offset += 2;  // disk number
		offset += 6;  // attributes
		bin.writeUint(data, offset, roff);  offset+=4;	// usize
	}
		
	bin.writeASCII(data, offset, p);  offset+= p.length;
	
	if(t==0) {
		for(var i=0; i<file.length; i++) data[offset+i] = file[i];
		offset += file.length;
	}
	
	return offset;
}





UZIP.crc = {
	table : ( function() {
	   var tab = new Uint32Array(256);
	   for (var n=0; n<256; n++) {
			var c = n;
			for (var k=0; k<8; k++) {
				if (c & 1)  c = 0xedb88320 ^ (c >>> 1);
				else        c = c >>> 1;
			}
			tab[n] = c;  }    
		return tab;  })(),
	update : function(c, buf, off, len) {
		for (var i=0; i<len; i++)  c = UPNG.crc.table[(c ^ buf[off+i]) & 0xff] ^ (c >>> 8);
		return c;
	},
	crc : function(b,o,l)  {  return UPNG.crc.update(0xffffffff,b,o,l) ^ 0xffffffff;  }
}

UZIP.bin = {
	readUshort : function(buff,p)  {  return (buff[p]) | (buff[p+1]<<8);  },
	writeUshort: function(buff,p,n){  buff[p] = (n)&255;  buff[p+1] = (n>>8)&255;  },
	readUint   : function(buff,p)  {  return (buff[p+3]*(256*256*256)) + ((buff[p+2]<<16) | (buff[p+1]<< 8) | buff[p]);  },
	writeUint  : function(buff,p,n){  buff[p+3]=(n>>24)&255;  buff[p+2]=(n>>16)&255;  buff[p+1]=(n>>8)&255;  buff[p]=n&255;  },
	readASCII  : function(buff,p,l){  var s = "";  for(var i=0; i<l; i++) s += String.fromCharCode(buff[p+i]);  return s;    },
	writeASCII : function(data,p,s){  for(var i=0; i<s.length; i++) data[p+i] = s.charCodeAt(i);  }
}/*!
 * Paper.js v0.11.3 - The Swiss Army Knife of Vector Graphics Scripting.
 * http://paperjs.org/
 *
 * Copyright (c) 2011 - 2016, Juerg Lehni & Jonathan Puckey
 * http://scratchdisk.com/ & http://jonathanpuckey.com/
 *
 * Distributed under the MIT license. See LICENSE file for details.
 *
 * All rights reserved.
 *
 * Date: Sat Apr 22 20:01:34 2017 +0200
 *
 ***
 *
 * Straps.js - Class inheritance library with support for bean-style accessors
 *
 * Copyright (c) 2006 - 2016 Juerg Lehni
 * http://scratchdisk.com/
 *
 * Distributed under the MIT license.
 *
 ***
 *
 * Acorn.js
 * http://marijnhaverbeke.nl/acorn/
 *
 * Acorn is a tiny, fast JavaScript parser written in JavaScript,
 * created by Marijn Haverbeke and released under an MIT license.
 *
 */
var paper=function(t,e){t=t||require("./node/self.js");var n=t.window,i=t.document,r=new function(){function t(t,e,r,s,a){function u(i,u){u=u||(u=o(e,i))&&(u.get?u:u.value),"string"==typeof u&&"#"===u[0]&&(u=t[u.substring(1)]||u);var c,f="function"==typeof u,d=u,_=a||f&&!u.base?u&&u.get?i in t:t[i]:null;a&&_||(f&&_&&(u.base=_),f&&s!==!1&&(c=i.match(/^([gs]et|is)(([A-Z])(.*))$/))&&(l[c[3].toLowerCase()+c[4]]=c[2]),d&&!f&&d.get&&"function"==typeof d.get&&n.isPlainObject(d)||(d={value:d,writable:!0}),(o(t,i)||{configurable:!0}).configurable&&(d.configurable=!0,d.enumerable=null!=r?r:!c),h(t,i,d))}var l={};if(e){for(var c in e)e.hasOwnProperty(c)&&!i.test(c)&&u(c);for(var c in l){var f=l[c],d=t["set"+f],_=t["get"+f]||d&&t["is"+f];!_||s!==!0&&0!==_.length||u(c,{get:_,set:d})}}return t}function n(){for(var t=0,e=arguments.length;t<e;t++){var n=arguments[t];n&&c(this,n)}return this}var i=/^(statics|enumerable|beans|preserve)$/,r=[],s=r.slice,a=Object.create,o=Object.getOwnPropertyDescriptor,h=Object.defineProperty,u=r.forEach||function(t,e){for(var n=0,i=this.length;n<i;n++)t.call(e,this[n],n,this)},l=function(t,e){for(var n in this)this.hasOwnProperty(n)&&t.call(e,this[n],n,this)},c=Object.assign||function(t){for(var e=1,n=arguments.length;e<n;e++){var i=arguments[e];for(var r in i)i.hasOwnProperty(r)&&(t[r]=i[r])}return t},f=function(t,e,n){if(t){var i=o(t,"length");(i&&"number"==typeof i.value?u:l).call(t,e,n=n||t)}return n};return t(n,{inject:function(e){if(e){var n=e.statics===!0?e:e.statics,i=e.beans,r=e.preserve;n!==e&&t(this.prototype,e,e.enumerable,i,r),t(this,n,null,i,r)}for(var s=1,a=arguments.length;s<a;s++)this.inject(arguments[s]);return this},extend:function(){for(var e,n,i,r=this,s=0,o=arguments.length;s<o&&(!e||!n);s++)i=arguments[s],e=e||i.initialize,n=n||i.prototype;return e=e||function(){r.apply(this,arguments)},n=e.prototype=n||a(this.prototype),h(n,"constructor",{value:e,writable:!0,configurable:!0}),t(e,this),arguments.length&&this.inject.apply(e,arguments),e.base=r,e}}).inject({enumerable:!1,initialize:n,set:n,inject:function(){for(var e=0,n=arguments.length;e<n;e++){var i=arguments[e];i&&t(this,i,i.enumerable,i.beans,i.preserve)}return this},extend:function(){var t=a(this);return t.inject.apply(t,arguments)},each:function(t,e){return f(this,t,e)},clone:function(){return new this.constructor(this)},statics:{set:c,each:f,create:a,define:h,describe:o,clone:function(t){return c(new t.constructor,t)},isPlainObject:function(t){var e=null!=t&&t.constructor;return e&&(e===Object||e===n||"Object"===e.name)},pick:function(t,n){return t!==e?t:n},slice:function(t,e,n){return s.call(t,e,n)}}})};"undefined"!=typeof module&&(module.exports=r),r.inject({enumerable:!1,toString:function(){return null!=this._id?(this._class||"Object")+(this._name?" '"+this._name+"'":" @"+this._id):"{ "+r.each(this,function(t,e){if(!/^_/.test(e)){var n=typeof t;this.push(e+": "+("number"===n?h.instance.number(t):"string"===n?"'"+t+"'":t))}},[]).join(", ")+" }"},getClassName:function(){return this._class||""},importJSON:function(t){return r.importJSON(t,this)},exportJSON:function(t){return r.exportJSON(this,t)},toJSON:function(){return r.serialize(this)},set:function(t,e){return t&&r.filter(this,t,e,this._prioritize),this}},{beans:!1,statics:{exports:{},extend:function rt(){var t=rt.base.apply(this,arguments),e=t.prototype._class;return e&&!r.exports[e]&&(r.exports[e]=t),t},equals:function(t,e){if(t===e)return!0;if(t&&t.equals)return t.equals(e);if(e&&e.equals)return e.equals(t);if(t&&e&&"object"==typeof t&&"object"==typeof e){if(Array.isArray(t)&&Array.isArray(e)){var n=t.length;if(n!==e.length)return!1;for(;n--;)if(!r.equals(t[n],e[n]))return!1}else{var i=Object.keys(t),n=i.length;if(n!==Object.keys(e).length)return!1;for(;n--;){var s=i[n];if(!e.hasOwnProperty(s)||!r.equals(t[s],e[s]))return!1}}return!0}return!1},read:function(t,n,i,s){if(this===r){var a=this.peek(t,n);return t.__index++,a}var o=this.prototype,h=o._readIndex,u=n||h&&t.__index||0,l=t.length,c=t[u];if(s=s||l-u,c instanceof this||i&&i.readNull&&null==c&&s<=1)return h&&(t.__index=u+1),c&&i&&i.clone?c.clone():c;if(c=r.create(o),h&&(c.__read=!0),c=c.initialize.apply(c,u>0||u+s<l?r.slice(t,u,u+s):t)||c,h){t.__index=u+c.__read;var f=c.__filtered;f&&(t.__filtered=f,c.__filtered=e),c.__read=e}return c},peek:function(t,e){return t[t.__index=e||t.__index||0]},remain:function(t){return t.length-(t.__index||0)},readList:function(t,e,n,i){for(var r,s=[],a=e||0,o=i?a+i:t.length,h=a;h<o;h++)s.push(Array.isArray(r=t[h])?this.read(r,0,n):this.read(t,h,n,1));return s},readNamed:function(t,n,i,s,a){var o=this.getNamed(t,n),h=o!==e;if(h){var u=t.__filtered;u||(u=t.__filtered=r.create(t[0]),u.__unfiltered=t[0]),u[n]=e}var l=h?[o]:t,c=this.read(l,i,s,a);return c},getNamed:function(t,n){var i=t[0];if(t._hasObject===e&&(t._hasObject=1===t.length&&r.isPlainObject(i)),t._hasObject)return n?i[n]:t.__filtered||i},hasNamed:function(t,e){return!!this.getNamed(t,e)},filter:function(t,n,i,r){function s(r){if(!(i&&r in i||a&&r in a)){var s=n[r];s!==e&&(t[r]=s)}}var a;if(r){for(var o,h={},u=0,l=r.length;u<l;u++)(o=r[u])in n&&(s(o),h[o]=!0);a=h}return Object.keys(n.__unfiltered||n).forEach(s),t},isPlainValue:function(t,e){return r.isPlainObject(t)||Array.isArray(t)||e&&"string"==typeof t},serialize:function(t,e,n,i){e=e||{};var s,a=!i;if(a&&(e.formatter=new h(e.precision),i={length:0,definitions:{},references:{},add:function(t,e){var n="#"+t._id,i=this.references[n];if(!i){this.length++;var r=e.call(t),s=t._class;s&&r[0]!==s&&r.unshift(s),this.definitions[n]=r,i=this.references[n]=[n]}return i}}),t&&t._serialize){s=t._serialize(e,i);var o=t._class;!o||t._compactSerialize||!a&&n||s[0]===o||s.unshift(o)}else if(Array.isArray(t)){s=[];for(var u=0,l=t.length;u<l;u++)s[u]=r.serialize(t[u],e,n,i)}else if(r.isPlainObject(t)){s={};for(var c=Object.keys(t),u=0,l=c.length;u<l;u++){var f=c[u];s[f]=r.serialize(t[f],e,n,i)}}else s="number"==typeof t?e.formatter.number(t,e.precision):t;return a&&i.length>0?[["dictionary",i.definitions],s]:s},deserialize:function(t,e,n,i,s){var a=t,o=!n,h=o&&t&&t.length&&"dictionary"===t[0][0];if(n=n||{},Array.isArray(t)){var u=t[0],l="dictionary"===u;if(1==t.length&&/^#/.test(u))return n.dictionary[u];u=r.exports[u],a=[];for(var c=u?1:0,f=t.length;c<f;c++)a.push(r.deserialize(t[c],e,n,l,h));if(u){var d=a;e?a=e(u,d,o||s):(a=r.create(u.prototype),u.apply(a,d))}}else if(r.isPlainObject(t)){a={},i&&(n.dictionary=a);for(var _ in t)a[_]=r.deserialize(t[_],e,n)}return h?a[1]:a},exportJSON:function(t,e){var n=r.serialize(t,e);return e&&0==e.asString?n:JSON.stringify(n)},importJSON:function(t,e){return r.deserialize("string"==typeof t?JSON.parse(t):t,function(t,n,i){var s=i&&e&&e.constructor===t,a=s?e:r.create(t.prototype);if(1===n.length&&a instanceof w&&(s||!(a instanceof b))){var o=n[0];r.isPlainObject(o)&&(o.insert=!1)}return(s?a.set:t).apply(a,n),s&&(e=null),a})},splice:function(t,n,i,r){var s=n&&n.length,a=i===e;i=a?t.length:i,i>t.length&&(i=t.length);for(var o=0;o<s;o++)n[o]._index=i+o;if(a)return t.push.apply(t,n),[];var h=[i,r];n&&h.push.apply(h,n);for(var u=t.splice.apply(t,h),o=0,l=u.length;o<l;o++)u[o]._index=e;for(var o=i+s,l=t.length;o<l;o++)t[o]._index=o;return u},capitalize:function(t){return t.replace(/\b[a-z]/g,function(t){return t.toUpperCase()})},camelize:function(t){return t.replace(/-(.)/g,function(t,e){return e.toUpperCase()})},hyphenate:function(t){return t.replace(/([a-z])([A-Z])/g,"$1-$2").toLowerCase()}}});var s={on:function(t,e){if("string"!=typeof t)r.each(t,function(t,e){this.on(e,t)},this);else{var n=this._eventTypes,i=n&&n[t],s=this._callbacks=this._callbacks||{};s=s[t]=s[t]||[],s.indexOf(e)===-1&&(s.push(e),i&&i.install&&1===s.length&&i.install.call(this,t))}return this},off:function(t,e){if("string"!=typeof t)return void r.each(t,function(t,e){this.off(e,t)},this);var n,i=this._eventTypes,s=i&&i[t],a=this._callbacks&&this._callbacks[t];return a&&(!e||(n=a.indexOf(e))!==-1&&1===a.length?(s&&s.uninstall&&s.uninstall.call(this,t),delete this._callbacks[t]):n!==-1&&a.splice(n,1)),this},once:function(t,e){return this.on(t,function(){e.apply(this,arguments),this.off(t,e)})},emit:function(t,e){var n=this._callbacks&&this._callbacks[t];if(!n)return!1;var i=r.slice(arguments,1),s=e&&e.target&&!e.currentTarget;n=n.slice(),s&&(e.currentTarget=this);for(var a=0,o=n.length;a<o;a++)if(0==n[a].apply(this,i)){e&&e.stop&&e.stop();break}return s&&delete e.currentTarget,!0},responds:function(t){return!(!this._callbacks||!this._callbacks[t])},attach:"#on",detach:"#off",fire:"#emit",_installEvents:function(t){var e=this._eventTypes,n=this._callbacks,i=t?"install":"uninstall";if(e)for(var r in n)if(n[r].length>0){var s=e[r],a=s&&s[i];a&&a.call(this,r)}},statics:{inject:function st(t){var e=t._events;if(e){var n={};r.each(e,function(e,i){var s="string"==typeof e,a=s?e:i,o=r.capitalize(a),h=a.substring(2).toLowerCase();n[h]=s?{}:e,a="_"+a,t["get"+o]=function(){return this[a]},t["set"+o]=function(t){var e=this[a];e&&this.off(h,e),t&&this.on(h,t),this[a]=t}}),t._eventTypes=n}return st.base.apply(this,arguments)}}},a=r.extend({_class:"PaperScope",initialize:function at(){paper=this,this.settings=new r({applyMatrix:!0,insertItems:!0,handleSize:4,hitTolerance:0}),this.project=null,this.projects=[],this.tools=[],this._id=at._id++,at._scopes[this._id]=this;var e=at.prototype;if(!this.support){var n=tt.getContext(1,1)||{};e.support={nativeDash:"setLineDash"in n||"mozDash"in n,nativeBlendModes:et.nativeModes},tt.release(n)}if(!this.agent){var i=t.navigator.userAgent.toLowerCase(),s=(/(darwin|win|mac|linux|freebsd|sunos)/.exec(i)||[])[0],a="darwin"===s?"mac":s,o=e.agent=e.browser={platform:a};a&&(o[a]=!0),i.replace(/(opera|chrome|safari|webkit|firefox|msie|trident|atom|node)\/?\s*([.\d]+)(?:.*version\/([.\d]+))?(?:.*rv\:v?([.\d]+))?/g,function(t,e,n,i,r){if(!o.chrome){var s="opera"===e?i:/^(node|trident)$/.test(e)?r:n;o.version=s,o.versionNumber=parseFloat(s),e="trident"===e?"msie":e,o.name=e,o[e]=!0}}),o.chrome&&delete o.webkit,o.atom&&delete o.chrome}},version:"0.11.3",getView:function(){var t=this.project;return t&&t._view},getPaper:function(){return this},execute:function(t,e){paper.PaperScript.execute(t,this,e),Z.updateFocus()},install:function(t){var e=this;r.each(["project","view","tool"],function(n){r.define(t,n,{configurable:!0,get:function(){return e[n]}})});for(var n in this)!/^_/.test(n)&&this[n]&&(t[n]=this[n])},setup:function(t){return paper=this,this.project=new y(t),this},createCanvas:function(t,e){return tt.getCanvas(t,e)},activate:function(){paper=this},clear:function(){for(var t=this.projects,e=this.tools,n=t.length-1;n>=0;n--)t[n].remove();for(var n=e.length-1;n>=0;n--)e[n].remove()},remove:function(){this.clear(),delete a._scopes[this._id]},statics:new function(){function t(t){return t+="Attribute",function(e,n){return e[t](n)||e[t]("data-paper-"+n)}}return{_scopes:{},_id:0,get:function(t){return this._scopes[t]||null},getAttribute:t("get"),hasAttribute:t("has")}}}),o=r.extend(s,{initialize:function(t){this._scope=paper,this._index=this._scope[this._list].push(this)-1,!t&&this._scope[this._reference]||this.activate()},activate:function(){if(!this._scope)return!1;var t=this._scope[this._reference];return t&&t!==this&&t.emit("deactivate"),this._scope[this._reference]=this,this.emit("activate",t),!0},isActive:function(){return this._scope[this._reference]===this},remove:function(){return null!=this._index&&(r.splice(this._scope[this._list],null,this._index,1),this._scope[this._reference]==this&&(this._scope[this._reference]=null),this._scope=null,!0)},getView:function(){return this._scope.getView()}}),h=r.extend({initialize:function(t){this.precision=r.pick(t,5),this.multiplier=Math.pow(10,this.precision)},number:function(t){return this.precision<16?Math.round(t*this.multiplier)/this.multiplier:t},pair:function(t,e,n){return this.number(t)+(n||",")+this.number(e)},point:function(t,e){return this.number(t.x)+(e||",")+this.number(t.y)},size:function(t,e){return this.number(t.width)+(e||",")+this.number(t.height)},rectangle:function(t,e){return this.point(t,e)+(e||",")+this.size(t,e)}});h.instance=new h;var u=new function(){function t(t,e,n){return t<e?e:t>n?n:t}function e(t,e,n){function i(t){var e=134217729*t,n=t-e,i=n+e,r=t-i;return[i,r]}var r=e*e-t*n,a=e*e+t*n;if(3*s(r)<a){var o=i(t),h=i(e),u=i(n),l=e*e,c=h[0]*h[0]-l+2*h[0]*h[1]+h[1]*h[1],f=t*n,d=o[0]*u[0]-f+o[0]*u[1]+o[1]*u[0]+o[1]*u[1];r=l-f+(c-d)}return r}function n(){var t=Math.max.apply(Math,arguments);return t&&(t<1e-8||t>1e8)?o(2,-Math.round(h(t))):0}var i=[[.5773502691896257],[0,.7745966692414834],[.33998104358485626,.8611363115940526],[0,.5384693101056831,.906179845938664],[.2386191860831969,.6612093864662645,.932469514203152],[0,.4058451513773972,.7415311855993945,.9491079123427585],[.1834346424956498,.525532409916329,.7966664774136267,.9602898564975363],[0,.3242534234038089,.6133714327005904,.8360311073266358,.9681602395076261],[.14887433898163122,.4333953941292472,.6794095682990244,.8650633666889845,.9739065285171717],[0,.26954315595234496,.5190961292068118,.7301520055740494,.8870625997680953,.978228658146057],[.1252334085114689,.3678314989981802,.5873179542866175,.7699026741943047,.9041172563704749,.9815606342467192],[0,.2304583159551348,.44849275103644687,.6423493394403402,.8015780907333099,.9175983992229779,.9841830547185881],[.10805494870734367,.31911236892788974,.5152486363581541,.6872929048116855,.827201315069765,.9284348836635735,.9862838086968123],[0,.20119409399743451,.3941513470775634,.5709721726085388,.7244177313601701,.8482065834104272,.937273392400706,.9879925180204854],[.09501250983763744,.2816035507792589,.45801677765722737,.6178762444026438,.755404408355003,.8656312023878318,.9445750230732326,.9894009349916499]],r=[[1],[.8888888888888888,.5555555555555556],[.6521451548625461,.34785484513745385],[.5688888888888889,.47862867049936647,.23692688505618908],[.46791393457269104,.3607615730481386,.17132449237917036],[.4179591836734694,.3818300505051189,.27970539148927664,.1294849661688697],[.362683783378362,.31370664587788727,.22238103445337448,.10122853629037626],[.3302393550012598,.31234707704000286,.26061069640293544,.1806481606948574,.08127438836157441],[.29552422471475287,.26926671930999635,.21908636251598204,.1494513491505806,.06667134430868814],[.2729250867779006,.26280454451024665,.23319376459199048,.18629021092773426,.1255803694649046,.05566856711617366],[.24914704581340277,.2334925365383548,.20316742672306592,.16007832854334622,.10693932599531843,.04717533638651183],[.2325515532308739,.22628318026289723,.2078160475368885,.17814598076194574,.13887351021978725,.09212149983772845,.04048400476531588],[.2152638534631578,.2051984637212956,.18553839747793782,.15720316715819355,.12151857068790319,.08015808715976021,.03511946033175186],[.2025782419255613,.19843148532711158,.1861610000155622,.16626920581699392,.13957067792615432,.10715922046717194,.07036604748810812,.03075324199611727],[.1894506104550685,.18260341504492358,.16915651939500254,.14959598881657674,.12462897125553388,.09515851168249279,.062253523938647894,.027152459411754096]],s=Math.abs,a=Math.sqrt,o=Math.pow,h=Math.log2||function(t){return Math.log(t)*Math.LOG2E},l=1e-12,c=1.12e-16;return{EPSILON:l,MACHINE_EPSILON:c,CURVETIME_EPSILON:1e-8,GEOMETRIC_EPSILON:1e-7,TRIGONOMETRIC_EPSILON:1e-8,KAPPA:4*(a(2)-1)/3,isZero:function(t){return t>=-l&&t<=l},clamp:t,integrate:function(t,e,n,s){for(var a=i[s-2],o=r[s-2],h=.5*(n-e),u=h+e,l=0,c=s+1>>1,f=1&s?o[l++]*t(u):0;l<c;){var d=h*a[l];f+=o[l++]*(t(u+d)+t(u-d))}return h*f},findRoot:function(e,n,i,r,a,o,h){for(var u=0;u<o;u++){var l=e(i),c=l/n(i),f=i-c;if(s(c)<h){i=f;break}l>0?(a=i,i=f<=r?.5*(r+a):f):(r=i,i=f>=a?.5*(r+a):f)}return t(i,r,a)},solveQuadratic:function(i,r,o,h,u,f){var d,_=1/0;if(s(i)<l){if(s(r)<l)return s(o)<l?-1:0;d=-o/r}else{r*=-.5;var g=e(i,r,o);if(g&&s(g)<c){var v=n(s(i),s(r),s(o));v&&(i*=v,r*=v,o*=v,g=e(i,r,o))}if(g>=-c){var p=g<0?0:a(g),m=r+(r<0?-p:p);0===m?(d=o/i,_=-d):(d=m/i,_=o/m)}}var y=0,w=null==u,x=u-l,b=f+l;return isFinite(d)&&(w||d>x&&d<b)&&(h[y++]=w?d:t(d,u,f)),_!==d&&isFinite(_)&&(w||_>x&&_<b)&&(h[y++]=w?_:t(_,u,f)),y},solveCubic:function(e,i,r,h,f,d,_){function g(t){v=t;var n=e*v;p=n+i,m=p*v+r,y=(n+p)*v+m,w=m*v+h}var v,p,m,y,w,x=n(s(e),s(i),s(r),s(h));if(x&&(e*=x,i*=x,r*=x,h*=x),s(e)<l)e=i,p=r,m=h,v=1/0;else if(s(h)<l)p=i,m=r,v=0;else{g(-(i/e)/3);var b=w/e,C=o(s(b),1/3),S=b<0?-1:1,k=-y/e,I=k>0?1.324717957244746*Math.max(C,a(k)):C,P=v-S*I;if(P!==v){do g(P),P=0===y?v:v-w/y/(1+c);while(S*P>S*v);s(e)*v*v>s(h/v)&&(m=-h/v,p=(m-r)/v)}}var A=u.solveQuadratic(e,p,m,f,d,_),M=null==d;return isFinite(v)&&(0===A||A>0&&v!==f[0]&&v!==f[1])&&(M||v>d-l&&v<_+l)&&(f[A++]=M?v:t(v,d,_)),A}}},l={_id:1,_pools:{},get:function(t){if(t){var e=this._pools[t];return e||(e=this._pools[t]={_id:1}),e._id++}return this._id++}},c=r.extend({_class:"Point",_readIndex:!0,initialize:function(t,e){var n=typeof t,i=this.__read,r=0;if("number"===n){var s="number"==typeof e;this._set(t,s?e:t),i&&(r=s?2:1)}else if("undefined"===n||null===t)this._set(0,0),i&&(r=null===t?1:0);else{var a="string"===n?t.split(/[\s,]+/)||[]:t;r=1,Array.isArray(a)?this._set(+a[0],+(a.length>1?a[1]:a[0])):"x"in a?this._set(a.x||0,a.y||0):"width"in a?this._set(a.width||0,a.height||0):"angle"in a?(this._set(a.length||0,0),this.setAngle(a.angle||0)):(this._set(0,0),r=0)}return i&&(this.__read=r),this},set:"#initialize",_set:function(t,e){return this.x=t,this.y=e,this},equals:function(t){return this===t||t&&(this.x===t.x&&this.y===t.y||Array.isArray(t)&&this.x===t[0]&&this.y===t[1])||!1},clone:function(){return new c(this.x,this.y)},toString:function(){var t=h.instance;return"{ x: "+t.number(this.x)+", y: "+t.number(this.y)+" }"},_serialize:function(t){var e=t.formatter;return[e.number(this.x),e.number(this.y)]},getLength:function(){return Math.sqrt(this.x*this.x+this.y*this.y)},setLength:function(t){if(this.isZero()){var e=this._angle||0;this._set(Math.cos(e)*t,Math.sin(e)*t)}else{var n=t/this.getLength();u.isZero(n)&&this.getAngle(),this._set(this.x*n,this.y*n)}},getAngle:function(){return 180*this.getAngleInRadians.apply(this,arguments)/Math.PI},setAngle:function(t){this.setAngleInRadians.call(this,t*Math.PI/180)},getAngleInDegrees:"#getAngle",setAngleInDegrees:"#setAngle",getAngleInRadians:function(){if(arguments.length){var t=c.read(arguments),e=this.getLength()*t.getLength();if(u.isZero(e))return NaN;var n=this.dot(t)/e;return Math.acos(n<-1?-1:n>1?1:n)}return this.isZero()?this._angle||0:this._angle=Math.atan2(this.y,this.x)},setAngleInRadians:function(t){if(this._angle=t,!this.isZero()){var e=this.getLength();this._set(Math.cos(t)*e,Math.sin(t)*e)}},getQuadrant:function(){return this.x>=0?this.y>=0?1:4:this.y>=0?2:3}},{beans:!1,getDirectedAngle:function(){var t=c.read(arguments);return 180*Math.atan2(this.cross(t),this.dot(t))/Math.PI},getDistance:function(){var t=c.read(arguments),e=t.x-this.x,n=t.y-this.y,i=e*e+n*n,s=r.read(arguments);return s?i:Math.sqrt(i)},normalize:function(t){t===e&&(t=1);var n=this.getLength(),i=0!==n?t/n:0,r=new c(this.x*i,this.y*i);return i>=0&&(r._angle=this._angle),r},rotate:function(t,e){if(0===t)return this.clone();t=t*Math.PI/180;var n=e?this.subtract(e):this,i=Math.sin(t),r=Math.cos(t);return n=new c(n.x*r-n.y*i,n.x*i+n.y*r),e?n.add(e):n},transform:function(t){return t?t._transformPoint(this):this},add:function(){var t=c.read(arguments);return new c(this.x+t.x,this.y+t.y)},subtract:function(){var t=c.read(arguments);return new c(this.x-t.x,this.y-t.y)},multiply:function(){var t=c.read(arguments);return new c(this.x*t.x,this.y*t.y)},divide:function(){var t=c.read(arguments);return new c(this.x/t.x,this.y/t.y)},modulo:function(){var t=c.read(arguments);return new c(this.x%t.x,this.y%t.y)},negate:function(){return new c((-this.x),(-this.y))},isInside:function(){return g.read(arguments).contains(this)},isClose:function(){var t=c.read(arguments),e=r.read(arguments);return this.getDistance(t)<=e},isCollinear:function(){var t=c.read(arguments);return c.isCollinear(this.x,this.y,t.x,t.y)},isColinear:"#isCollinear",isOrthogonal:function(){var t=c.read(arguments);return c.isOrthogonal(this.x,this.y,t.x,t.y)},isZero:function(){var t=u.isZero;return t(this.x)&&t(this.y)},isNaN:function(){return isNaN(this.x)||isNaN(this.y)},isInQuadrant:function(t){return this.x*(t>1&&t<4?-1:1)>=0&&this.y*(t>2?-1:1)>=0},dot:function(){var t=c.read(arguments);return this.x*t.x+this.y*t.y},cross:function(){var t=c.read(arguments);return this.x*t.y-this.y*t.x},project:function(){var t=c.read(arguments),e=t.isZero()?0:this.dot(t)/t.dot(t);return new c(t.x*e,t.y*e)},statics:{min:function(){var t=c.read(arguments),e=c.read(arguments);return new c(Math.min(t.x,e.x),Math.min(t.y,e.y))},max:function(){var t=c.read(arguments),e=c.read(arguments);return new c(Math.max(t.x,e.x),Math.max(t.y,e.y))},random:function(){return new c(Math.random(),Math.random())},isCollinear:function(t,e,n,i){return Math.abs(t*i-e*n)<=1e-8*Math.sqrt((t*t+e*e)*(n*n+i*i))},isOrthogonal:function(t,e,n,i){return Math.abs(t*n+e*i)<=1e-8*Math.sqrt((t*t+e*e)*(n*n+i*i))}}},r.each(["round","ceil","floor","abs"],function(t){var e=Math[t];this[t]=function(){return new c(e(this.x),e(this.y))}},{})),f=c.extend({initialize:function(t,e,n,i){this._x=t,this._y=e,this._owner=n,this._setter=i},_set:function(t,e,n){return this._x=t,this._y=e,n||this._owner[this._setter](this),this},getX:function(){return this._x},setX:function(t){this._x=t,this._owner[this._setter](this)},getY:function(){return this._y},setY:function(t){this._y=t,this._owner[this._setter](this)},isSelected:function(){return!!(this._owner._selection&this._getSelection())},setSelected:function(t){this._owner.changeSelection(this._getSelection(),t)},_getSelection:function(){return"setPosition"===this._setter?4:0}}),d=r.extend({_class:"Size",_readIndex:!0,initialize:function(t,e){var n=typeof t,i=this.__read,r=0;if("number"===n){var s="number"==typeof e;this._set(t,s?e:t),i&&(r=s?2:1)}else if("undefined"===n||null===t)this._set(0,0),i&&(r=null===t?1:0);else{var a="string"===n?t.split(/[\s,]+/)||[]:t;r=1,Array.isArray(a)?this._set(+a[0],+(a.length>1?a[1]:a[0])):"width"in a?this._set(a.width||0,a.height||0):"x"in a?this._set(a.x||0,a.y||0):(this._set(0,0),r=0)}return i&&(this.__read=r),this},set:"#initialize",_set:function(t,e){return this.width=t,this.height=e,this},equals:function(t){return t===this||t&&(this.width===t.width&&this.height===t.height||Array.isArray(t)&&this.width===t[0]&&this.height===t[1])||!1},clone:function(){return new d(this.width,this.height)},toString:function(){var t=h.instance;return"{ width: "+t.number(this.width)+", height: "+t.number(this.height)+" }"},_serialize:function(t){var e=t.formatter;return[e.number(this.width),e.number(this.height)]},add:function(){var t=d.read(arguments);return new d(this.width+t.width,this.height+t.height)},subtract:function(){var t=d.read(arguments);return new d(this.width-t.width,this.height-t.height)},multiply:function(){var t=d.read(arguments);return new d(this.width*t.width,this.height*t.height)},divide:function(){var t=d.read(arguments);return new d(this.width/t.width,this.height/t.height)},modulo:function(){var t=d.read(arguments);return new d(this.width%t.width,this.height%t.height)},negate:function(){return new d((-this.width),(-this.height))},isZero:function(){var t=u.isZero;return t(this.width)&&t(this.height)},isNaN:function(){return isNaN(this.width)||isNaN(this.height)},statics:{min:function(t,e){return new d(Math.min(t.width,e.width),Math.min(t.height,e.height))},max:function(t,e){return new d(Math.max(t.width,e.width),Math.max(t.height,e.height))},random:function(){return new d(Math.random(),Math.random())}}},r.each(["round","ceil","floor","abs"],function(t){var e=Math[t];this[t]=function(){return new d(e(this.width),e(this.height))}},{})),_=d.extend({initialize:function(t,e,n,i){this._width=t,this._height=e,this._owner=n,this._setter=i},_set:function(t,e,n){return this._width=t,this._height=e,n||this._owner[this._setter](this),this},getWidth:function(){return this._width},setWidth:function(t){this._width=t,this._owner[this._setter](this)},getHeight:function(){return this._height},setHeight:function(t){this._height=t,this._owner[this._setter](this)}}),g=r.extend({_class:"Rectangle",_readIndex:!0,beans:!0,initialize:function(t,n,i,s){var a,o=typeof t;if("number"===o?(this._set(t,n,i,s),a=4):"undefined"===o||null===t?(this._set(0,0,0,0),a=null===t?1:0):1===arguments.length&&(Array.isArray(t)?(this._set.apply(this,t),a=1):t.x!==e||t.width!==e?(this._set(t.x||0,t.y||0,t.width||0,t.height||0),a=1):t.from===e&&t.to===e&&(this._set(0,0,0,0),r.filter(this,t),a=1)),a===e){var h,u,l=c.readNamed(arguments,"from"),f=r.peek(arguments),_=l.x,g=l.y;if(f&&f.x!==e||r.hasNamed(arguments,"to")){var v=c.readNamed(arguments,"to");h=v.x-_,u=v.y-g,h<0&&(_=v.x,h=-h),u<0&&(g=v.y,u=-u)}else{var p=d.read(arguments);h=p.width,u=p.height}this._set(_,g,h,u),a=arguments.__index;var m=arguments.__filtered;m&&(this.__filtered=m)}return this.__read&&(this.__read=a),this},set:"#initialize",_set:function(t,e,n,i){return this.x=t,this.y=e,this.width=n,this.height=i,this},clone:function(){return new g(this.x,this.y,this.width,this.height)},equals:function(t){var e=r.isPlainValue(t)?g.read(arguments):t;return e===this||e&&this.x===e.x&&this.y===e.y&&this.width===e.width&&this.height===e.height||!1},toString:function(){var t=h.instance;return"{ x: "+t.number(this.x)+", y: "+t.number(this.y)+", width: "+t.number(this.width)+", height: "+t.number(this.height)+" }"},_serialize:function(t){var e=t.formatter;return[e.number(this.x),e.number(this.y),e.number(this.width),e.number(this.height)]},getPoint:function(t){var e=t?c:f;return new e(this.x,this.y,this,"setPoint")},setPoint:function(){var t=c.read(arguments);this.x=t.x,this.y=t.y},getSize:function(t){var e=t?d:_;return new e(this.width,this.height,this,"setSize")},_fw:1,_fh:1,setSize:function(){var t=d.read(arguments),e=this._sx,n=this._sy,i=t.width,r=t.height;e&&(this.x+=(this.width-i)*e),n&&(this.y+=(this.height-r)*n),this.width=i,this.height=r,this._fw=this._fh=1},getLeft:function(){return this.x},setLeft:function(t){if(!this._fw){var e=t-this.x;this.width-=.5===this._sx?2*e:e}this.x=t,this._sx=this._fw=0},getTop:function(){return this.y},setTop:function(t){if(!this._fh){var e=t-this.y;this.height-=.5===this._sy?2*e:e}this.y=t,this._sy=this._fh=0},getRight:function(){return this.x+this.width},setRight:function(t){if(!this._fw){var e=t-this.x;this.width=.5===this._sx?2*e:e}this.x=t-this.width,this._sx=1,this._fw=0},getBottom:function(){return this.y+this.height},setBottom:function(t){if(!this._fh){var e=t-this.y;this.height=.5===this._sy?2*e:e}this.y=t-this.height,this._sy=1,this._fh=0},getCenterX:function(){return this.x+this.width/2},setCenterX:function(t){this._fw||.5===this._sx?this.x=t-this.width/2:(this._sx&&(this.x+=2*(t-this.x)*this._sx),this.width=2*(t-this.x)),this._sx=.5,this._fw=0},getCenterY:function(){return this.y+this.height/2},setCenterY:function(t){this._fh||.5===this._sy?this.y=t-this.height/2:(this._sy&&(this.y+=2*(t-this.y)*this._sy),this.height=2*(t-this.y)),this._sy=.5,this._fh=0},getCenter:function(t){var e=t?c:f;return new e(this.getCenterX(),this.getCenterY(),this,"setCenter")},setCenter:function(){var t=c.read(arguments);return this.setCenterX(t.x),this.setCenterY(t.y),this},getArea:function(){return this.width*this.height},isEmpty:function(){return 0===this.width||0===this.height},contains:function(t){return t&&t.width!==e||4===(Array.isArray(t)?t:arguments).length?this._containsRectangle(g.read(arguments)):this._containsPoint(c.read(arguments))},_containsPoint:function(t){var e=t.x,n=t.y;return e>=this.x&&n>=this.y&&e<=this.x+this.width&&n<=this.y+this.height},_containsRectangle:function(t){var e=t.x,n=t.y;return e>=this.x&&n>=this.y&&e+t.width<=this.x+this.width&&n+t.height<=this.y+this.height},intersects:function(){var t=g.read(arguments),e=r.read(arguments)||0;return t.x+t.width>this.x-e&&t.y+t.height>this.y-e&&t.x<this.x+this.width+e&&t.y<this.y+this.height+e},intersect:function(){var t=g.read(arguments),e=Math.max(this.x,t.x),n=Math.max(this.y,t.y),i=Math.min(this.x+this.width,t.x+t.width),r=Math.min(this.y+this.height,t.y+t.height);return new g(e,n,i-e,r-n)},unite:function(){var t=g.read(arguments),e=Math.min(this.x,t.x),n=Math.min(this.y,t.y),i=Math.max(this.x+this.width,t.x+t.width),r=Math.max(this.y+this.height,t.y+t.height);return new g(e,n,i-e,r-n)},include:function(){var t=c.read(arguments),e=Math.min(this.x,t.x),n=Math.min(this.y,t.y),i=Math.max(this.x+this.width,t.x),r=Math.max(this.y+this.height,t.y);return new g(e,n,i-e,r-n)},expand:function(){var t=d.read(arguments),e=t.width,n=t.height;return new g(this.x-e/2,this.y-n/2,this.width+e,this.height+n)},scale:function(t,n){return this.expand(this.width*t-this.width,this.height*(n===e?t:n)-this.height)}},r.each([["Top","Left"],["Top","Right"],["Bottom","Left"],["Bottom","Right"],["Left","Center"],["Top","Center"],["Right","Center"],["Bottom","Center"]],function(t,e){var n=t.join(""),i=/^[RL]/.test(n);e>=4&&(t[1]+=i?"Y":"X");var r=t[i?0:1],s=t[i?1:0],a="get"+r,o="get"+s,h="set"+r,u="set"+s,l="get"+n,d="set"+n;this[l]=function(t){var e=t?c:f;return new e(this[a](),this[o](),this,d)},this[d]=function(){var t=c.read(arguments);this[h](t.x),this[u](t.y)}},{beans:!0})),v=g.extend({initialize:function(t,e,n,i,r,s){this._set(t,e,n,i,!0),this._owner=r,this._setter=s},_set:function(t,e,n,i,r){return this._x=t,this._y=e,this._width=n,this._height=i,r||this._owner[this._setter](this),this}},new function(){var t=g.prototype;return r.each(["x","y","width","height"],function(t){var e=r.capitalize(t),n="_"+t;this["get"+e]=function(){return this[n]},this["set"+e]=function(t){this[n]=t,this._dontNotify||this._owner[this._setter](this)}},r.each(["Point","Size","Center","Left","Top","Right","Bottom","CenterX","CenterY","TopLeft","TopRight","BottomLeft","BottomRight","LeftCenter","TopCenter","RightCenter","BottomCenter"],function(e){var n="set"+e;this[n]=function(){this._dontNotify=!0,t[n].apply(this,arguments),this._dontNotify=!1,this._owner[this._setter](this)}},{isSelected:function(){return!!(2&this._owner._selection)},setSelected:function(t){var e=this._owner;e.changeSelection&&e.changeSelection(2,t)}}))}),p=r.extend({_class:"Matrix",initialize:function ot(t,e){var n=arguments.length,i=!0;if(n>=6?this._set.apply(this,arguments):1===n||2===n?t instanceof ot?this._set(t._a,t._b,t._c,t._d,t._tx,t._ty,e):Array.isArray(t)?this._set.apply(this,e?t.concat([e]):t):i=!1:n?i=!1:this.reset(),!i)throw new Error("Unsupported matrix parameters");return this},set:"#initialize",_set:function(t,e,n,i,r,s,a){return this._a=t,this._b=e,this._c=n,this._d=i,this._tx=r,this._ty=s,a||this._changed(),this},_serialize:function(t,e){return r.serialize(this.getValues(),t,!0,e)},_changed:function(){var t=this._owner;t&&(t._applyMatrix?t.transform(null,!0):t._changed(9))},clone:function(){return new p(this._a,this._b,this._c,this._d,this._tx,this._ty)},equals:function(t){return t===this||t&&this._a===t._a&&this._b===t._b&&this._c===t._c&&this._d===t._d&&this._tx===t._tx&&this._ty===t._ty},toString:function(){var t=h.instance;return"[["+[t.number(this._a),t.number(this._c),t.number(this._tx)].join(", ")+"], ["+[t.number(this._b),t.number(this._d),t.number(this._ty)].join(", ")+"]]"},reset:function(t){return this._a=this._d=1,this._b=this._c=this._tx=this._ty=0,t||this._changed(),this},apply:function(t,e){var n=this._owner;return!!n&&(n.transform(null,!0,r.pick(t,!0),e),this.isIdentity())},translate:function(){var t=c.read(arguments),e=t.x,n=t.y;return this._tx+=e*this._a+n*this._c,this._ty+=e*this._b+n*this._d,this._changed(),this},scale:function(){var t=c.read(arguments),e=c.read(arguments,0,{readNull:!0});return e&&this.translate(e),this._a*=t.x,this._b*=t.x,this._c*=t.y,this._d*=t.y,e&&this.translate(e.negate()),this._changed(),this},rotate:function(t){t*=Math.PI/180;
var e=c.read(arguments,1),n=e.x,i=e.y,r=Math.cos(t),s=Math.sin(t),a=n-n*r+i*s,o=i-n*s-i*r,h=this._a,u=this._b,l=this._c,f=this._d;return this._a=r*h+s*l,this._b=r*u+s*f,this._c=-s*h+r*l,this._d=-s*u+r*f,this._tx+=a*h+o*l,this._ty+=a*u+o*f,this._changed(),this},shear:function(){var t=c.read(arguments),e=c.read(arguments,0,{readNull:!0});e&&this.translate(e);var n=this._a,i=this._b;return this._a+=t.y*this._c,this._b+=t.y*this._d,this._c+=t.x*n,this._d+=t.x*i,e&&this.translate(e.negate()),this._changed(),this},skew:function(){var t=c.read(arguments),e=c.read(arguments,0,{readNull:!0}),n=Math.PI/180,i=new c(Math.tan(t.x*n),Math.tan(t.y*n));return this.shear(i,e)},append:function(t,e){if(t){var n=this._a,i=this._b,r=this._c,s=this._d,a=t._a,o=t._c,h=t._b,u=t._d,l=t._tx,c=t._ty;this._a=a*n+h*r,this._c=o*n+u*r,this._b=a*i+h*s,this._d=o*i+u*s,this._tx+=l*n+c*r,this._ty+=l*i+c*s,e||this._changed()}return this},prepend:function(t,e){if(t){var n=this._a,i=this._b,r=this._c,s=this._d,a=this._tx,o=this._ty,h=t._a,u=t._c,l=t._b,c=t._d,f=t._tx,d=t._ty;this._a=h*n+u*i,this._c=h*r+u*s,this._b=l*n+c*i,this._d=l*r+c*s,this._tx=h*a+u*o+f,this._ty=l*a+c*o+d,e||this._changed()}return this},appended:function(t){return this.clone().append(t)},prepended:function(t){return this.clone().prepend(t)},invert:function(){var t=this._a,e=this._b,n=this._c,i=this._d,r=this._tx,s=this._ty,a=t*i-e*n,o=null;return a&&!isNaN(a)&&isFinite(r)&&isFinite(s)&&(this._a=i/a,this._b=-e/a,this._c=-n/a,this._d=t/a,this._tx=(n*s-i*r)/a,this._ty=(e*r-t*s)/a,o=this),o},inverted:function(){return this.clone().invert()},concatenate:"#append",preConcatenate:"#prepend",chain:"#appended",_shiftless:function(){return new p(this._a,this._b,this._c,this._d,0,0)},_orNullIfIdentity:function(){return this.isIdentity()?null:this},isIdentity:function(){return 1===this._a&&0===this._b&&0===this._c&&1===this._d&&0===this._tx&&0===this._ty},isInvertible:function(){var t=this._a*this._d-this._c*this._b;return t&&!isNaN(t)&&isFinite(this._tx)&&isFinite(this._ty)},isSingular:function(){return!this.isInvertible()},transform:function(t,e,n){return arguments.length<3?this._transformPoint(c.read(arguments)):this._transformCoordinates(t,e,n)},_transformPoint:function(t,e,n){var i=t.x,r=t.y;return e||(e=new c),e._set(i*this._a+r*this._c+this._tx,i*this._b+r*this._d+this._ty,n)},_transformCoordinates:function(t,e,n){for(var i=0,r=2*n;i<r;i+=2){var s=t[i],a=t[i+1];e[i]=s*this._a+a*this._c+this._tx,e[i+1]=s*this._b+a*this._d+this._ty}return e},_transformCorners:function(t){var e=t.x,n=t.y,i=e+t.width,r=n+t.height,s=[e,n,i,n,i,r,e,r];return this._transformCoordinates(s,s,4)},_transformBounds:function(t,e,n){for(var i=this._transformCorners(t),r=i.slice(0,2),s=r.slice(),a=2;a<8;a++){var o=i[a],h=1&a;o<r[h]?r[h]=o:o>s[h]&&(s[h]=o)}return e||(e=new g),e._set(r[0],r[1],s[0]-r[0],s[1]-r[1],n)},inverseTransform:function(){return this._inverseTransform(c.read(arguments))},_inverseTransform:function(t,e,n){var i=this._a,r=this._b,s=this._c,a=this._d,o=this._tx,h=this._ty,u=i*a-r*s,l=null;if(u&&!isNaN(u)&&isFinite(o)&&isFinite(h)){var f=t.x-this._tx,d=t.y-this._ty;e||(e=new c),l=e._set((f*a-d*s)/u,(d*i-f*r)/u,n)}return l},decompose:function(){var t,e,n,i=this._a,r=this._b,s=this._c,a=this._d,o=i*a-r*s,h=Math.sqrt,u=Math.atan2,l=180/Math.PI;if(0!==i||0!==r){var f=h(i*i+r*r);t=Math.acos(i/f)*(r>0?1:-1),e=[f,o/f],n=[u(i*s+r*a,f*f),0]}else if(0!==s||0!==a){var d=h(s*s+a*a);t=Math.asin(s/d)*(a>0?1:-1),e=[o/d,d],n=[0,u(i*s+r*a,d*d)]}else t=0,n=e=[0,0];return{translation:this.getTranslation(),rotation:t*l,scaling:new c(e),skewing:new c(n[0]*l,n[1]*l)}},getValues:function(){return[this._a,this._b,this._c,this._d,this._tx,this._ty]},getTranslation:function(){return new c(this._tx,this._ty)},getScaling:function(){return(this.decompose()||{}).scaling},getRotation:function(){return(this.decompose()||{}).rotation},applyToContext:function(t){this.isIdentity()||t.transform(this._a,this._b,this._c,this._d,this._tx,this._ty)}},r.each(["a","b","c","d","tx","ty"],function(t){var e=r.capitalize(t),n="_"+t;this["get"+e]=function(){return this[n]},this["set"+e]=function(t){this[n]=t,this._changed()}},{})),m=r.extend({_class:"Line",initialize:function(t,e,n,i,r){var s=!1;arguments.length>=4?(this._px=t,this._py=e,this._vx=n,this._vy=i,s=r):(this._px=t.x,this._py=t.y,this._vx=e.x,this._vy=e.y,s=n),s||(this._vx-=this._px,this._vy-=this._py)},getPoint:function(){return new c(this._px,this._py)},getVector:function(){return new c(this._vx,this._vy)},getLength:function(){return this.getVector().getLength()},intersect:function(t,e){return m.intersect(this._px,this._py,this._vx,this._vy,t._px,t._py,t._vx,t._vy,!0,e)},getSide:function(t,e){return m.getSide(this._px,this._py,this._vx,this._vy,t.x,t.y,!0,e)},getDistance:function(t){return Math.abs(this.getSignedDistance(t))},getSignedDistance:function(t){return m.getSignedDistance(this._px,this._py,this._vx,this._vy,t.x,t.y,!0)},isCollinear:function(t){return c.isCollinear(this._vx,this._vy,t._vx,t._vy)},isOrthogonal:function(t){return c.isOrthogonal(this._vx,this._vy,t._vx,t._vy)},statics:{intersect:function(t,e,n,i,r,s,a,o,h,l){h||(n-=t,i-=e,a-=r,o-=s);var f=n*o-i*a;if(!u.isZero(f)){var d=t-r,_=e-s,g=(a*_-o*d)/f,v=(n*_-i*d)/f,p=1e-12,m=-p,y=1+p;if(l||m<g&&g<y&&m<v&&v<y)return l||(g=g<=0?0:g>=1?1:g),new c(t+g*n,e+g*i)}},getSide:function(t,e,n,i,r,s,a,o){a||(n-=t,i-=e);var h=r-t,l=s-e,c=h*i-l*n;return!o&&u.isZero(c)&&(c=(h*n+h*n)/(n*n+i*i),c>=0&&c<=1&&(c=0)),c<0?-1:c>0?1:0},getSignedDistance:function(t,e,n,i,r,s,a){return a||(n-=t,i-=e),0===n?i>0?r-t:t-r:0===i?n<0?s-e:e-s:((r-t)*i-(s-e)*n)/Math.sqrt(n*n+i*i)},getDistance:function(t,e,n,i,r,s,a){return Math.abs(m.getSignedDistance(t,e,n,i,r,s,a))}}}),y=o.extend({_class:"Project",_list:"projects",_reference:"project",_compactSerialize:!0,initialize:function(t){o.call(this,!0),this._children=[],this._namedChildren={},this._activeLayer=null,this._currentStyle=new V(null,null,this),this._view=Z.create(this,t||tt.getCanvas(1,1)),this._selectionItems={},this._selectionCount=0,this._updateVersion=0},_serialize:function(t,e){return r.serialize(this._children,t,!0,e)},_changed:function(t,e){if(1&t){var n=this._view;n&&(n._needsUpdate=!0,!n._requested&&n._autoUpdate&&n.requestUpdate())}var i=this._changes;if(i&&e){var r=this._changesById,s=e._id,a=r[s];a?a.flags|=t:i.push(r[s]={item:e,flags:t})}},clear:function(){for(var t=this._children,e=t.length-1;e>=0;e--)t[e].remove()},isEmpty:function(){return!this._children.length},remove:function ht(){return!!ht.base.call(this)&&(this._view&&this._view.remove(),!0)},getView:function(){return this._view},getCurrentStyle:function(){return this._currentStyle},setCurrentStyle:function(t){this._currentStyle.set(t)},getIndex:function(){return this._index},getOptions:function(){return this._scope.settings},getLayers:function(){return this._children},getActiveLayer:function(){return this._activeLayer||new b({project:this,insert:!0})},getSymbolDefinitions:function(){var t=[],e={};return this.getItems({"class":k,match:function(n){var i=n._definition,r=i._id;return e[r]||(e[r]=!0,t.push(i)),!1}}),t},getSymbols:"getSymbolDefinitions",getSelectedItems:function(){var t=this._selectionItems,e=[];for(var n in t){var i=t[n],r=i._selection;1&r&&i.isInserted()?e.push(i):r||this._updateSelection(i)}return e},_updateSelection:function(t){var e=t._id,n=this._selectionItems;t._selection?n[e]!==t&&(this._selectionCount++,n[e]=t):n[e]===t&&(this._selectionCount--,delete n[e])},selectAll:function(){for(var t=this._children,e=0,n=t.length;e<n;e++)t[e].setFullySelected(!0)},deselectAll:function(){var t=this._selectionItems;for(var e in t)t[e].setFullySelected(!1)},addLayer:function(t){return this.insertLayer(e,t)},insertLayer:function(t,e){if(e instanceof b){e._remove(!1,!0),r.splice(this._children,[e],t,0),e._setProject(this,!0);var n=e._name;n&&e.setName(n),this._changes&&e._changed(5),this._activeLayer||(this._activeLayer=e)}else e=null;return e},_insertItem:function(t,n,i){return n=this.insertLayer(t,n)||(this._activeLayer||this._insertItem(e,new b(w.NO_INSERT),!0)).insertChild(t,n),i&&n.activate&&n.activate(),n},getItems:function(t){return w._getItems(this,t)},getItem:function(t){return w._getItems(this,t,null,null,!0)[0]||null},importJSON:function(t){this.activate();var e=this._activeLayer;return r.importJSON(t,e&&e.isEmpty()&&e)},removeOn:function(t){var e=this._removeSets;if(e){"mouseup"===t&&(e.mousedrag=null);var n=e[t];if(n){for(var i in n){var r=n[i];for(var s in e){var a=e[s];a&&a!=n&&delete a[r._id]}r.remove()}e[t]=null}}},draw:function(t,e,n){this._updateVersion++,t.save(),e.applyToContext(t);for(var i=this._children,s=new r({offset:new c(0,0),pixelRatio:n,viewMatrix:e.isIdentity()?null:e,matrices:[new p],updateMatrix:!0}),a=0,o=i.length;a<o;a++)i[a].draw(t,s);if(t.restore(),this._selectionCount>0){t.save(),t.strokeWidth=1;var h=this._selectionItems,u=this._scope.settings.handleSize,l=this._updateVersion;for(var f in h)h[f]._drawSelection(t,e,u,h,l);t.restore()}}}),w=r.extend(s,{statics:{extend:function ut(t){return t._serializeFields&&(t._serializeFields=r.set({},this.prototype._serializeFields,t._serializeFields)),ut.base.apply(this,arguments)},NO_INSERT:{insert:!1}},_class:"Item",_name:null,_applyMatrix:!0,_canApplyMatrix:!0,_canScaleStroke:!1,_pivot:null,_visible:!0,_blendMode:"normal",_opacity:1,_locked:!1,_guide:!1,_clipMask:!1,_selection:0,_selectBounds:!0,_selectChildren:!1,_serializeFields:{name:null,applyMatrix:null,matrix:new p,pivot:null,visible:!0,blendMode:"normal",opacity:1,locked:!1,guide:!1,clipMask:!1,selected:!1,data:{}},_prioritize:["applyMatrix"]},new function(){var t=["onMouseDown","onMouseUp","onMouseDrag","onClick","onDoubleClick","onMouseMove","onMouseEnter","onMouseLeave"];return r.each(t,function(t){this._events[t]={install:function(t){this.getView()._countItemEvent(t,1)},uninstall:function(t){this.getView()._countItemEvent(t,-1)}}},{_events:{onFrame:{install:function(){this.getView()._animateItem(this,!0)},uninstall:function(){this.getView()._animateItem(this,!1)}},onLoad:{},onError:{}},statics:{_itemHandlers:t}})},{initialize:function(){},_initialize:function(t,n){var i=t&&r.isPlainObject(t),s=i&&t.internal===!0,a=this._matrix=new p,o=i&&t.project||paper.project,h=paper.settings;return this._id=s?null:l.get(),this._parent=this._index=null,this._applyMatrix=this._canApplyMatrix&&h.applyMatrix,n&&a.translate(n),a._owner=this,this._style=new V(o._currentStyle,this,o),s||i&&0==t.insert||!h.insertItems&&(!i||t.insert!==!0)?this._setProject(o):(i&&t.parent||o)._insertItem(e,this,!0),i&&t!==w.NO_INSERT&&this.set(t,{internal:!0,insert:!0,project:!0,parent:!0}),i},_serialize:function(t,e){function n(n){for(var a in n){var o=s[a];r.equals(o,"leading"===a?1.2*n.fontSize:n[a])||(i[a]=r.serialize(o,t,"data"!==a,e))}}var i={},s=this;return n(this._serializeFields),this instanceof x||n(this._style._defaults),[this._class,i]},_changed:function(t){var n=this._symbol,i=this._parent||n,r=this._project;8&t&&(this._bounds=this._position=this._decomposed=this._globalMatrix=e),i&&40&t&&w._clearBoundsCache(i),2&t&&w._clearBoundsCache(this),r&&r._changed(t,this),n&&n._changed(t)},getId:function(){return this._id},getName:function(){return this._name},setName:function(t){if(this._name&&this._removeNamed(),t===+t+"")throw new Error("Names consisting only of numbers are not supported.");var n=this._getOwner();if(t&&n){var i=n._children,r=n._namedChildren;(r[t]=r[t]||[]).push(this),t in i||(i[t]=this)}this._name=t||e,this._changed(128)},getStyle:function(){return this._style},setStyle:function(t){this.getStyle().set(t)}},r.each(["locked","visible","blendMode","opacity","guide"],function(t){var e=r.capitalize(t),n="_"+t,i={locked:128,visible:137};this["get"+e]=function(){return this[n]},this["set"+e]=function(e){e!=this[n]&&(this[n]=e,this._changed(i[t]||129))}},{}),{beans:!0,getSelection:function(){return this._selection},setSelection:function(t){if(t!==this._selection){this._selection=t;var e=this._project;e&&(e._updateSelection(this),this._changed(129))}},changeSelection:function(t,e){var n=this._selection;this.setSelection(e?n|t:n&~t)},isSelected:function(){if(this._selectChildren)for(var t=this._children,e=0,n=t.length;e<n;e++)if(t[e].isSelected())return!0;return!!(1&this._selection)},setSelected:function(t){if(this._selectChildren)for(var e=this._children,n=0,i=e.length;n<i;n++)e[n].setSelected(t);this.changeSelection(1,t)},isFullySelected:function(){var t=this._children,e=!!(1&this._selection);if(t&&e){for(var n=0,i=t.length;n<i;n++)if(!t[n].isFullySelected())return!1;return!0}return e},setFullySelected:function(t){var e=this._children;if(e)for(var n=0,i=e.length;n<i;n++)e[n].setFullySelected(t);this.changeSelection(1,t)},isClipMask:function(){return this._clipMask},setClipMask:function(t){this._clipMask!=(t=!!t)&&(this._clipMask=t,t&&(this.setFillColor(null),this.setStrokeColor(null)),this._changed(129),this._parent&&this._parent._changed(1024))},getData:function(){return this._data||(this._data={}),this._data},setData:function(t){this._data=t},getPosition:function(t){var e=this._position,n=t?c:f;if(!e){var i=this._pivot;e=this._position=i?this._matrix._transformPoint(i):this.getBounds().getCenter(!0)}return new n(e.x,e.y,this,"setPosition")},setPosition:function(){this.translate(c.read(arguments).subtract(this.getPosition(!0)))},getPivot:function(){var t=this._pivot;return t?new f(t.x,t.y,this,"setPivot"):null},setPivot:function(){this._pivot=c.read(arguments,0,{clone:!0,readNull:!0}),this._position=e}},r.each({getStrokeBounds:{stroke:!0},getHandleBounds:{handle:!0},getInternalBounds:{internal:!0}},function(t,e){this[e]=function(e){return this.getBounds(e,t)}},{beans:!0,getBounds:function(t,e){var n=e||t instanceof p,i=r.set({},n?e:t,this._boundsOptions);i.stroke&&!this.getStrokeScaling()||(i.cacheItem=this);var s=this._getCachedBounds(n&&t,i).rect;return arguments.length?s:new v(s.x,s.y,s.width,s.height,this,"setBounds")},setBounds:function(){var t=g.read(arguments),e=this.getBounds(),n=this._matrix,i=new p,r=t.getCenter();i.translate(r),t.width==e.width&&t.height==e.height||(n.isInvertible()||(n.set(n._backup||(new p).translate(n.getTranslation())),e=this.getBounds()),i.scale(0!==e.width?t.width/e.width:0,0!==e.height?t.height/e.height:0)),r=e.getCenter(),i.translate(-r.x,-r.y),this.transform(i)},_getBounds:function(t,e){var n=this._children;return n&&n.length?(w._updateBoundsCache(this,e.cacheItem),w._getBounds(n,t,e)):new g},_getBoundsCacheKey:function(t,e){return[t.stroke?1:0,t.handle?1:0,e?1:0].join("")},_getCachedBounds:function(t,e,n){t=t&&t._orNullIfIdentity();var i=e.internal&&!n,r=e.cacheItem,s=i?null:this._matrix._orNullIfIdentity(),a=r&&(!t||t.equals(s))&&this._getBoundsCacheKey(e,i),o=this._bounds;if(w._updateBoundsCache(this._parent||this._symbol,r),a&&o&&a in o){var h=o[a];return{rect:h.rect.clone(),nonscaling:h.nonscaling}}var u=this._getBounds(t||s,e),l=u.rect||u,c=this._style,f=u.nonscaling||c.hasStroke()&&!c.getStrokeScaling();if(a){o||(this._bounds=o={});var h=o[a]={rect:l.clone(),nonscaling:f,internal:i}}return{rect:l,nonscaling:f}},_getStrokeMatrix:function(t,e){var n=this.getStrokeScaling()?null:e&&e.internal?this:this._parent||this._symbol&&this._symbol._item,i=n?n.getViewMatrix().invert():t;return i&&i._shiftless()},statics:{_updateBoundsCache:function(t,e){if(t&&e){var n=e._id,i=t._boundsCache=t._boundsCache||{ids:{},list:[]};i.ids[n]||(i.list.push(e),i.ids[n]=e)}},_clearBoundsCache:function(t){var n=t._boundsCache;if(n){t._bounds=t._position=t._boundsCache=e;for(var i=0,r=n.list,s=r.length;i<s;i++){var a=r[i];a!==t&&(a._bounds=a._position=e,a._boundsCache&&w._clearBoundsCache(a))}}},_getBounds:function(t,e,n){var i=1/0,r=-i,s=i,a=r,o=!1;n=n||{};for(var h=0,u=t.length;h<u;h++){var l=t[h];if(l._visible&&!l.isEmpty()){var c=l._getCachedBounds(e&&e.appended(l._matrix),n,!0),f=c.rect;i=Math.min(f.x,i),s=Math.min(f.y,s),r=Math.max(f.x+f.width,r),a=Math.max(f.y+f.height,a),c.nonscaling&&(o=!0)}}return{rect:isFinite(i)?new g(i,s,r-i,a-s):new g,nonscaling:o}}}}),{beans:!0,_decompose:function(){return this._applyMatrix?null:this._decomposed||(this._decomposed=this._matrix.decompose())},getRotation:function(){var t=this._decompose();return t?t.rotation:0},setRotation:function(t){var e=this.getRotation();if(null!=e&&null!=t){var n=this._decomposed;this.rotate(t-e),n&&(n.rotation=t,this._decomposed=n)}},getScaling:function(){var t=this._decompose(),e=t&&t.scaling;return new f(e?e.x:1,e?e.y:1,this,"setScaling")},setScaling:function(){var t=this.getScaling(),e=c.read(arguments,0,{clone:!0,readNull:!0});if(t&&e&&!t.equals(e)){var n=this.getRotation(),i=this._decomposed,r=new p,s=this.getPosition(!0);r.translate(s),n&&r.rotate(n),r.scale(e.x/t.x,e.y/t.y),n&&r.rotate(-n),r.translate(s.negate()),this.transform(r),i&&(i.scaling=e,this._decomposed=i)}},getMatrix:function(){return this._matrix},setMatrix:function(){var t=this._matrix;t.initialize.apply(t,arguments)},getGlobalMatrix:function(t){var e=this._globalMatrix,n=this._project._updateVersion;if(e&&e._updateVersion!==n&&(e=null),!e){e=this._globalMatrix=this._matrix.clone();var i=this._parent;i&&e.prepend(i.getGlobalMatrix(!0)),e._updateVersion=n}return t?e:e.clone()},getViewMatrix:function(){return this.getGlobalMatrix().prepend(this.getView()._matrix)},getApplyMatrix:function(){return this._applyMatrix},setApplyMatrix:function(t){(this._applyMatrix=this._canApplyMatrix&&!!t)&&this.transform(null,!0)},getTransformContent:"#getApplyMatrix",setTransformContent:"#setApplyMatrix"},{getProject:function(){return this._project},_setProject:function(t,e){if(this._project!==t){this._project&&this._installEvents(!1),this._project=t;for(var n=this._children,i=0,r=n&&n.length;i<r;i++)n[i]._setProject(t);e=!0}e&&this._installEvents(!0)},getView:function(){return this._project._view},_installEvents:function lt(t){lt.base.call(this,t);for(var e=this._children,n=0,i=e&&e.length;n<i;n++)e[n]._installEvents(t)},getLayer:function(){for(var t=this;t=t._parent;)if(t instanceof b)return t;return null},getParent:function(){return this._parent},setParent:function(t){return t.addChild(this)},_getOwner:"#getParent",getChildren:function(){return this._children},setChildren:function(t){this.removeChildren(),this.addChildren(t)},getFirstChild:function(){return this._children&&this._children[0]||null},getLastChild:function(){return this._children&&this._children[this._children.length-1]||null},getNextSibling:function(){var t=this._getOwner();return t&&t._children[this._index+1]||null},getPreviousSibling:function(){var t=this._getOwner();return t&&t._children[this._index-1]||null},getIndex:function(){return this._index},equals:function(t){return t===this||t&&this._class===t._class&&this._style.equals(t._style)&&this._matrix.equals(t._matrix)&&this._locked===t._locked&&this._visible===t._visible&&this._blendMode===t._blendMode&&this._opacity===t._opacity&&this._clipMask===t._clipMask&&this._guide===t._guide&&this._equals(t)||!1},_equals:function(t){return r.equals(this._children,t._children)},clone:function(t){var n=new this.constructor(w.NO_INSERT),i=this._children,s=r.pick(t?t.insert:e,t===e||t===!0),a=r.pick(t?t.deep:e,!0);i&&n.copyAttributes(this),i&&!a||n.copyContent(this),i||n.copyAttributes(this),s&&n.insertAbove(this);var o=this._name,h=this._parent;if(o&&h){for(var i=h._children,u=o,l=1;i[o];)o=u+" "+l++;o!==u&&n.setName(o)}return n},copyContent:function(t){for(var e=t._children,n=0,i=e&&e.length;n<i;n++)this.addChild(e[n].clone(!1),!0)},copyAttributes:function(t,e){this.setStyle(t._style);for(var n=["_locked","_visible","_blendMode","_opacity","_clipMask","_guide"],i=0,s=n.length;i<s;i++){var a=n[i];t.hasOwnProperty(a)&&(this[a]=t[a])}e||this._matrix.set(t._matrix,!0),this.setApplyMatrix(t._applyMatrix),this.setPivot(t._pivot),this.setSelection(t._selection);var o=t._data,h=t._name;this._data=o?r.clone(o):null,h&&this.setName(h)},rasterize:function(t,n){var i=this.getStrokeBounds(),s=(t||this.getView().getResolution())/72,a=i.getTopLeft().floor(),o=i.getBottomRight().ceil(),h=new d(o.subtract(a)),u=new S(w.NO_INSERT);if(!h.isZero()){var l=tt.getCanvas(h.multiply(s)),c=l.getContext("2d"),f=(new p).scale(s).translate(a.negate());c.save(),f.applyToContext(c),this.draw(c,new r({matrices:[f]})),c.restore(),u.setCanvas(l)}return u.transform((new p).translate(a.add(h.divide(2))).scale(1/s)),(n===e||n)&&u.insertAbove(this),u},contains:function(){return!!this._contains(this._matrix._inverseTransform(c.read(arguments)))},_contains:function(t){var e=this._children;if(e){for(var n=e.length-1;n>=0;n--)if(e[n].contains(t))return!0;return!1}return t.isInside(this.getInternalBounds())},isInside:function(){return g.read(arguments).contains(this.getBounds())},_asPathItem:function(){return new L.Rectangle({rectangle:this.getInternalBounds(),matrix:this._matrix,insert:!1})},intersects:function(t,e){return t instanceof w&&this._asPathItem().getIntersections(t._asPathItem(),null,e,!0).length>0}},new function(){function t(){return this._hitTest(c.read(arguments),P.getOptions(arguments))}function e(){var t=c.read(arguments),e=P.getOptions(arguments),n=[];return this._hitTest(t,r.set({all:n},e)),n}function n(t,e,n,i){var r=this._children;if(r)for(var s=r.length-1;s>=0;s--){var a=r[s],o=a!==i&&a._hitTest(t,e,n);if(o&&!e.all)return o}return null}return y.inject({hitTest:t,hitTestAll:e,_hitTest:n}),{hitTest:t,hitTestAll:e,_hitTestChildren:n}},{_hitTest:function(t,e,n){function i(t){return t&&_&&!_(t)&&(t=null),t&&e.all&&e.all.push(t),t}function s(e,n){var i=n?l["get"+n]():g.getPosition();if(t.subtract(i).divide(u).length<=1)return new P(e,g,{name:n?r.hyphenate(n):e,point:i})}if(this._locked||!this._visible||this._guide&&!e.guides||this.isEmpty())return null;var a=this._matrix,o=n?n.appended(a):this.getGlobalMatrix().prepend(this.getView()._matrix),h=Math.max(e.tolerance,1e-12),u=e._tolerancePadding=new d(L._getStrokePadding(h,a._shiftless().invert()));if(t=a._inverseTransform(t),!t||!this._children&&!this.getBounds({internal:!0,stroke:!0,handle:!0}).expand(u.multiply(2))._containsPoint(t))return null;var l,c,f=!(e.guides&&!this._guide||e.slctd&&!this.isSelected()||e.type&&e.type!==r.hyphenate(this._class)||e["class"]&&!(this instanceof e["class"])),_=e.match,g=this,v=e.position,p=e.center,m=e.bounds;if(f&&this._parent&&(v||p||m)){if((p||m)&&(l=this.getInternalBounds()),c=v&&s("position")||p&&s("center","Center"),!c&&m)for(var y=["TopLeft","TopRight","BottomLeft","BottomRight","LeftCenter","TopCenter","RightCenter","BottomCenter"],w=0;w<8&&!c;w++)c=s("bounds",y[w]);c=i(c)}return c||(c=this._hitTestChildren(t,e,o)||f&&i(this._hitTestSelf(t,e,o,this.getStrokeScaling()?null:o._shiftless().invert()))||null),c&&c.point&&(c.point=a.transform(c.point)),c},_hitTestSelf:function(t,e){if(e.fill&&this.hasFill()&&this._contains(t))return new P("fill",this)},matches:function(t,e){function n(t,e){for(var i in t)if(t.hasOwnProperty(i)){var s=t[i],a=e[i];if(r.isPlainObject(s)&&r.isPlainObject(a)){if(!n(s,a))return!1}else if(!r.equals(s,a))return!1}return!0}var i=typeof t;if("object"===i){for(var s in t)if(t.hasOwnProperty(s)&&!this.matches(s,t[s]))return!1;return!0}if("function"===i)return t(this);if("match"===t)return e(this);var a=/^(empty|editable)$/.test(t)?this["is"+r.capitalize(t)]():"type"===t?r.hyphenate(this._class):this[t];if("class"===t){if("function"==typeof e)return this instanceof e;a=this._class}if("function"==typeof e)return!!e(a);if(e){if(e.test)return e.test(a);if(r.isPlainObject(e))return n(e,a)}return r.equals(a,e)},getItems:function(t){return w._getItems(this,t,this._matrix)},getItem:function(t){return w._getItems(this,t,this._matrix,null,!0)[0]||null},statics:{_getItems:function ct(t,e,n,i,s){if(!i){var a="object"==typeof e&&e,o=a&&a.overlapping,h=a&&a.inside,u=o||h,l=u&&g.read([u]);i={items:[],recursive:a&&a.recursive!==!1,inside:!!h,overlapping:!!o,rect:l,path:o&&new L.Rectangle({rectangle:l,insert:!1})},a&&(e=r.filter({},e,{recursive:!0,inside:!0,overlapping:!0}))}var c=t._children,f=i.items,l=i.rect;n=l&&(n||new p);for(var d=0,_=c&&c.length;d<_;d++){var v=c[d],m=n&&n.appended(v._matrix),y=!0;if(l){var u=v.getBounds(m);if(!l.intersects(u))continue;l.contains(u)||i.overlapping&&(u.contains(l)||i.path.intersects(v,m))||(y=!1)}if(y&&v.matches(e)&&(f.push(v),s))break;if(i.recursive!==!1&&ct(v,e,m,i,s),s&&f.length>0)break}return f}}},{importJSON:function(t){var e=r.importJSON(t,this);return e!==this?this.addChild(e):e},addChild:function(t){return this.insertChild(e,t)},insertChild:function(t,e){var n=e?this.insertChildren(t,[e]):null;return n&&n[0]},addChildren:function(t){return this.insertChildren(this._children.length,t)},insertChildren:function(t,e){var n=this._children;if(n&&e&&e.length>0){e=r.slice(e);for(var i={},s=e.length-1;s>=0;s--){var a=e[s],o=a&&a._id;!a||i[o]?e.splice(s,1):(a._remove(!1,!0),i[o]=!0)}r.splice(n,e,t,0);for(var h=this._project,u=h._changes,s=0,l=e.length;s<l;s++){var a=e[s],c=a._name;a._parent=this,a._setProject(h,!0),c&&a.setName(c),u&&a._changed(5)}this._changed(11)}else e=null;return e},_insertItem:"#insertChild",_insertAt:function(t,e){var n=t&&t._getOwner(),i=t!==this&&n?this:null;return i&&(i._remove(!1,!0),n._insertItem(t._index+e,i)),i},insertAbove:function(t){return this._insertAt(t,1)},insertBelow:function(t){return this._insertAt(t,0)},sendToBack:function(){var t=this._getOwner();return t?t._insertItem(0,this):null},bringToFront:function(){var t=this._getOwner();return t?t._insertItem(e,this):null},appendTop:"#addChild",appendBottom:function(t){return this.insertChild(0,t)},moveAbove:"#insertAbove",moveBelow:"#insertBelow",addTo:function(t){return t._insertItem(e,this)},copyTo:function(t){return this.clone(!1).addTo(t)},reduce:function(t){var e=this._children;if(e&&1===e.length){var n=e[0].reduce(t);return this._parent?(n.insertAbove(this),this.remove()):n.remove(),n}return this},_removeNamed:function(){var t=this._getOwner();if(t){var e=t._children,n=t._namedChildren,i=this._name,r=n[i],s=r?r.indexOf(this):-1;s!==-1&&(e[i]==this&&delete e[i],r.splice(s,1),r.length?e[i]=r[0]:delete n[i])}},_remove:function(t,e){var n=this._getOwner(),i=this._project,s=this._index;return!!n&&(this._name&&this._removeNamed(),null!=s&&(i._activeLayer===this&&(i._activeLayer=this.getNextSibling()||this.getPreviousSibling()),r.splice(n._children,null,s,1)),this._installEvents(!1),t&&i._changes&&this._changed(5),e&&n._changed(11,this),this._parent=null,!0)},remove:function(){return this._remove(!0,!0)},replaceWith:function(t){var e=t&&t.insertBelow(this);return e&&this.remove(),e},removeChildren:function(t,e){if(!this._children)return null;t=t||0,e=r.pick(e,this._children.length);for(var n=r.splice(this._children,null,t,e-t),i=n.length-1;i>=0;i--)n[i]._remove(!0,!1);return n.length>0&&this._changed(11),n},clear:"#removeChildren",reverseChildren:function(){if(this._children){this._children.reverse();for(var t=0,e=this._children.length;t<e;t++)this._children[t]._index=t;this._changed(11)}},isEmpty:function(){var t=this._children;return!t||!t.length},isEditable:function(){for(var t=this;t;){if(!t._visible||t._locked)return!1;t=t._parent}return!0},hasFill:function(){return this.getStyle().hasFill()},hasStroke:function(){return this.getStyle().hasStroke()},hasShadow:function(){return this.getStyle().hasShadow()},_getOrder:function(t){function e(t){var e=[];do e.unshift(t);while(t=t._parent);return e}for(var n=e(this),i=e(t),r=0,s=Math.min(n.length,i.length);r<s;r++)if(n[r]!=i[r])return n[r]._index<i[r]._index?1:-1;return 0},hasChildren:function(){return this._children&&this._children.length>0},isInserted:function(){return!!this._parent&&this._parent.isInserted()},isAbove:function(t){return this._getOrder(t)===-1},isBelow:function(t){return 1===this._getOrder(t)},isParent:function(t){return this._parent===t},isChild:function(t){return t&&t._parent===this},isDescendant:function(t){for(var e=this;e=e._parent;)if(e===t)return!0;return!1},isAncestor:function(t){return!!t&&t.isDescendant(this)},isSibling:function(t){return this._parent===t._parent},isGroupedWith:function(t){for(var e=this._parent;e;){if(e._parent&&/^(Group|Layer|CompoundPath)$/.test(e._class)&&t.isDescendant(e))return!0;e=e._parent}return!1}},r.each(["rotate","scale","shear","skew"],function(t){var e="rotate"===t;this[t]=function(){var n=(e?r:c).read(arguments),i=c.read(arguments,0,{readNull:!0});return this.transform((new p)[t](n,i||this.getPosition(!0)))}},{translate:function(){var t=new p;return this.transform(t.translate.apply(t,arguments))},transform:function(t,e,n,i){var r=this._matrix,s=t&&!t.isIdentity(),a=(e||this._applyMatrix)&&(!r.isIdentity()||s||e&&n&&this._children);if(!s&&!a)return this;if(s){!t.isInvertible()&&r.isInvertible()&&(r._backup=r.getValues()),r.prepend(t,!0);var o=this._style,h=o.getFillColor(!0),u=o.getStrokeColor(!0);h&&h.transform(t),u&&u.transform(t)}if(a&&(a=this._transformContent(r,n,i))){var l=this._pivot;l&&r._transformPoint(l,l,!0),r.reset(!0),i&&this._canApplyMatrix&&(this._applyMatrix=!0)}var c=this._bounds,f=this._position;(s||a)&&this._changed(9);var d=s&&c&&t.decompose();if(d&&d.skewing.isZero()&&d.rotation%90===0){for(var _ in c){var g=c[_];if(g.nonscaling)delete c[_];else if(a||!g.internal){var v=g.rect;t._transformBounds(v,v)}}this._bounds=c;var p=c[this._getBoundsCacheKey(this._boundsOptions||{})];p&&(this._position=p.rect.getCenter(!0))}else s&&f&&this._pivot&&(this._position=t._transformPoint(f,f));return this},_transformContent:function(t,e,n){var i=this._children;if(i){for(var r=0,s=i.length;r<s;r++)i[r].transform(t,!0,e,n);return!0}},globalToLocal:function(){return this.getGlobalMatrix(!0)._inverseTransform(c.read(arguments))},localToGlobal:function(){return this.getGlobalMatrix(!0)._transformPoint(c.read(arguments))},parentToLocal:function(){return this._matrix._inverseTransform(c.read(arguments))},localToParent:function(){return this._matrix._transformPoint(c.read(arguments))},fitBounds:function(t,e){t=g.read(arguments);var n=this.getBounds(),i=n.height/n.width,r=t.height/t.width,s=(e?i>r:i<r)?t.width/n.width:t.height/n.height,a=new g(new c,new d(n.width*s,n.height*s));a.setCenter(t.getCenter()),this.setBounds(a)}}),{_setStyles:function(t,e,n){var i=this._style,r=this._matrix;if(i.hasFill()&&(t.fillStyle=i.getFillColor().toCanvasStyle(t,r)),i.hasStroke()){t.strokeStyle=i.getStrokeColor().toCanvasStyle(t,r),t.lineWidth=i.getStrokeWidth();var s=i.getStrokeJoin(),a=i.getStrokeCap(),o=i.getMiterLimit();if(s&&(t.lineJoin=s),a&&(t.lineCap=a),o&&(t.miterLimit=o),paper.support.nativeDash){var h=i.getDashArray(),u=i.getDashOffset();h&&h.length&&("setLineDash"in t?(t.setLineDash(h),t.lineDashOffset=u):(t.mozDash=h,t.mozDashOffset=u))}}if(i.hasShadow()){var l=e.pixelRatio||1,f=n._shiftless().prepend((new p).scale(l,l)),d=f.transform(new c(i.getShadowBlur(),0)),_=f.transform(this.getShadowOffset());t.shadowColor=i.getShadowColor().toCanvasStyle(t),t.shadowBlur=d.getLength(),t.shadowOffsetX=_.x,t.shadowOffsetY=_.y}},draw:function(t,e,n){var i=this._updateVersion=this._project._updateVersion;if(this._visible&&0!==this._opacity){var r=e.matrices,s=e.viewMatrix,a=this._matrix,o=r[r.length-1].appended(a);if(o.isInvertible()){s=s?s.appended(o):o,r.push(o),e.updateMatrix&&(o._updateVersion=i,this._globalMatrix=o);var h,u,l,c=this._blendMode,f=this._opacity,d="normal"===c,_=et.nativeModes[c],g=d&&1===f||e.dontStart||e.clip||(_||d&&f<1)&&this._canComposite(),v=e.pixelRatio||1;if(!g){var p=this.getStrokeBounds(s);if(!p.width||!p.height)return;l=e.offset,u=e.offset=p.getTopLeft().floor(),h=t,t=tt.getContext(p.getSize().ceil().add(1).multiply(v)),1!==v&&t.scale(v,v)}t.save();var m=n?n.appended(a):this._canScaleStroke&&!this.getStrokeScaling(!0)&&s,y=!g&&e.clipItem,w=!m||y;if(g?(t.globalAlpha=f,_&&(t.globalCompositeOperation=c)):w&&t.translate(-u.x,-u.y),w&&(g?a:s).applyToContext(t),y&&e.clipItem.draw(t,e.extend({clip:!0})),m){t.setTransform(v,0,0,v,0,0);var x=e.offset;
x&&t.translate(-x.x,-x.y)}this._draw(t,e,s,m),t.restore(),r.pop(),e.clip&&!e.dontFinish&&t.clip(),g||(et.process(c,t,h,f,u.subtract(l).multiply(v)),tt.release(t),e.offset=l)}}},_isUpdated:function(t){var e=this._parent;if(e instanceof E)return e._isUpdated(t);var n=this._updateVersion===t;return!n&&e&&e._visible&&e._isUpdated(t)&&(this._updateVersion=t,n=!0),n},_drawSelection:function(t,e,n,i,r){var s=this._selection,a=1&s,o=2&s||a&&this._selectBounds,h=4&s;if(this._drawSelected||(a=!1),(a||o||h)&&this._isUpdated(r)){var u,l=this.getSelectedColor(!0)||(u=this.getLayer())&&u.getSelectedColor(!0),c=e.appended(this.getGlobalMatrix(!0)),f=n/2;if(t.strokeStyle=t.fillStyle=l?l.toCanvasStyle(t):"#009dec",a&&this._drawSelected(t,c,i),h){var d=this.getPosition(!0),_=d.x,g=d.y;t.beginPath(),t.arc(_,g,f,0,2*Math.PI,!0),t.stroke();for(var v=[[0,-1],[1,0],[0,1],[-1,0]],p=f,m=n+1,y=0;y<4;y++){var w=v[y],x=w[0],b=w[1];t.moveTo(_+x*p,g+b*p),t.lineTo(_+x*m,g+b*m),t.stroke()}}if(o){var C=c._transformCorners(this.getInternalBounds());t.beginPath();for(var y=0;y<8;y++)t[y?"lineTo":"moveTo"](C[y],C[++y]);t.closePath(),t.stroke();for(var y=0;y<8;y++)t.fillRect(C[y]-f,C[++y]-f,n,n)}}},_canComposite:function(){return!1}},r.each(["down","drag","up","move"],function(t){this["removeOn"+r.capitalize(t)]=function(){var e={};return e[t]=!0,this.removeOn(e)}},{removeOn:function(t){for(var e in t)if(t[e]){var n="mouse"+e,i=this._project,r=i._removeSets=i._removeSets||{};r[n]=r[n]||{},r[n][this._id]=this}return this}})),x=w.extend({_class:"Group",_selectBounds:!1,_selectChildren:!0,_serializeFields:{children:[]},initialize:function(t){this._children=[],this._namedChildren={},this._initialize(t)||this.addChildren(Array.isArray(t)?t:arguments)},_changed:function ft(t){ft.base.call(this,t),1026&t&&(this._clipItem=e)},_getClipItem:function(){var t=this._clipItem;if(t===e){t=null;for(var n=this._children,i=0,r=n.length;i<r;i++)if(n[i]._clipMask){t=n[i];break}this._clipItem=t}return t},isClipped:function(){return!!this._getClipItem()},setClipped:function(t){var e=this.getFirstChild();e&&e.setClipMask(t)},_getBounds:function dt(t,e){var n=this._getClipItem();return n?n._getCachedBounds(t&&t.appended(n._matrix),r.set({},e,{stroke:!1})):dt.base.call(this,t,e)},_hitTestChildren:function _t(t,e,n){var i=this._getClipItem();return(!i||i.contains(t))&&_t.base.call(this,t,e,n,i)},_draw:function(t,e){var n=e.clip,i=!n&&this._getClipItem();e=e.extend({clipItem:i,clip:!1}),n?(t.beginPath(),e.dontStart=e.dontFinish=!0):i&&i.draw(t,e.extend({clip:!0}));for(var r=this._children,s=0,a=r.length;s<a;s++){var o=r[s];o!==i&&o.draw(t,e)}}}),b=x.extend({_class:"Layer",initialize:function(){x.apply(this,arguments)},_getOwner:function(){return this._parent||null!=this._index&&this._project},isInserted:function gt(){return this._parent?gt.base.call(this):null!=this._index},activate:function(){this._project._activeLayer=this},_hitTestSelf:function(){}}),C=w.extend({_class:"Shape",_applyMatrix:!1,_canApplyMatrix:!1,_canScaleStroke:!0,_serializeFields:{type:null,size:null,radius:null},initialize:function(t,e){this._initialize(t,e)},_equals:function(t){return this._type===t._type&&this._size.equals(t._size)&&r.equals(this._radius,t._radius)},copyContent:function(t){this.setType(t._type),this.setSize(t._size),this.setRadius(t._radius)},getType:function(){return this._type},setType:function(t){this._type=t},getShape:"#getType",setShape:"#setType",getSize:function(){var t=this._size;return new _(t.width,t.height,this,"setSize")},setSize:function(){var t=d.read(arguments);if(this._size){if(!this._size.equals(t)){var e=this._type,n=t.width,i=t.height;"rectangle"===e?this._radius.set(d.min(this._radius,t.divide(2))):"circle"===e?(n=i=(n+i)/2,this._radius=n/2):"ellipse"===e&&this._radius._set(n/2,i/2),this._size._set(n,i),this._changed(9)}}else this._size=t.clone()},getRadius:function(){var t=this._radius;return"circle"===this._type?t:new _(t.width,t.height,this,"setRadius")},setRadius:function(t){var e=this._type;if("circle"===e){if(t===this._radius)return;var n=2*t;this._radius=t,this._size._set(n,n)}else if(t=d.read(arguments),this._radius){if(this._radius.equals(t))return;if(this._radius.set(t),"rectangle"===e){var n=d.max(this._size,t.multiply(2));this._size.set(n)}else"ellipse"===e&&this._size._set(2*t.width,2*t.height)}else this._radius=t.clone();this._changed(9)},isEmpty:function(){return!1},toPath:function(t){var n=new(L[r.capitalize(this._type)])({center:new c,size:this._size,radius:this._radius,insert:!1});return n.copyAttributes(this),paper.settings.applyMatrix&&n.setApplyMatrix(!0),(t===e||t)&&n.insertAbove(this),n},toShape:"#clone",_asPathItem:function(){return this.toPath(!1)},_draw:function(t,e,n,i){var r=this._style,s=r.hasFill(),a=r.hasStroke(),o=e.dontFinish||e.clip,h=!i;if(s||a||o){var u=this._type,l=this._radius,c="circle"===u;if(e.dontStart||t.beginPath(),h&&c)t.arc(0,0,l,0,2*Math.PI,!0);else{var f=c?l:l.width,d=c?l:l.height,_=this._size,g=_.width,v=_.height;if(h&&"rectangle"===u&&0===f&&0===d)t.rect(-g/2,-v/2,g,v);else{var p=g/2,m=v/2,y=.44771525016920644,w=f*y,x=d*y,b=[-p,-m+d,-p,-m+x,-p+w,-m,-p+f,-m,p-f,-m,p-w,-m,p,-m+x,p,-m+d,p,m-d,p,m-x,p-w,m,p-f,m,-p+f,m,-p+w,m,-p,m-x,-p,m-d];i&&i.transform(b,b,32),t.moveTo(b[0],b[1]),t.bezierCurveTo(b[2],b[3],b[4],b[5],b[6],b[7]),p!==f&&t.lineTo(b[8],b[9]),t.bezierCurveTo(b[10],b[11],b[12],b[13],b[14],b[15]),m!==d&&t.lineTo(b[16],b[17]),t.bezierCurveTo(b[18],b[19],b[20],b[21],b[22],b[23]),p!==f&&t.lineTo(b[24],b[25]),t.bezierCurveTo(b[26],b[27],b[28],b[29],b[30],b[31])}}t.closePath()}o||!s&&!a||(this._setStyles(t,e,n),s&&(t.fill(r.getFillRule()),t.shadowColor="rgba(0,0,0,0)"),a&&t.stroke())},_canComposite:function(){return!(this.hasFill()&&this.hasStroke())},_getBounds:function(t,e){var n=new g(this._size).setCenter(0,0),i=this._style,r=e.stroke&&i.hasStroke()&&i.getStrokeWidth();return t&&(n=t._transformBounds(n)),r?n.expand(L._getStrokePadding(r,this._getStrokeMatrix(t,e))):n}},new function(){function t(t,e,n){var i=t._radius;if(!i.isZero())for(var r=t._size.divide(2),s=1;s<=4;s++){var a=new c(s>1&&s<4?-1:1,s>2?-1:1),o=a.multiply(r),h=o.subtract(a.multiply(i)),u=new g(n?o.add(a.multiply(n)):o,h);if(u.contains(e))return{point:h,quadrant:s}}}function e(t,e,n,i){var r=t.divide(e);return(!i||r.isInQuadrant(i))&&r.subtract(r.normalize()).multiply(e).divide(n).length<=1}return{_contains:function n(e){if("rectangle"===this._type){var i=t(this,e);return i?e.subtract(i.point).divide(this._radius).getLength()<=1:n.base.call(this,e)}return e.divide(this.size).getLength()<=.5},_hitTestSelf:function i(n,r,s,a){var o=!1,h=this._style,u=r.stroke&&h.hasStroke(),l=r.fill&&h.hasFill();if(u||l){var c=this._type,f=this._radius,d=u?h.getStrokeWidth()/2:0,_=r._tolerancePadding.add(L._getStrokePadding(d,!h.getStrokeScaling()&&a));if("rectangle"===c){var v=_.multiply(2),p=t(this,n,v);if(p)o=e(n.subtract(p.point),f,_,p.quadrant);else{var m=new g(this._size).setCenter(0,0),y=m.expand(v),w=m.expand(v.negate());o=y._containsPoint(n)&&!w._containsPoint(n)}}else o=e(n,f,_)}return o?new P(u?"stroke":"fill",this):i.base.apply(this,arguments)}}},{statics:new function(){function t(t,e,n,i,s){var a=new C(r.getNamed(s),e);return a._type=t,a._size=n,a._radius=i,a}return{Circle:function(){var e=c.readNamed(arguments,"center"),n=r.readNamed(arguments,"radius");return t("circle",e,new d(2*n),n,arguments)},Rectangle:function(){var e=g.readNamed(arguments,"rectangle"),n=d.min(d.readNamed(arguments,"radius"),e.getSize(!0).divide(2));return t("rectangle",e.getCenter(!0),e.getSize(!0),n,arguments)},Ellipse:function(){var e=C._readEllipse(arguments),n=e.radius;return t("ellipse",e.center,n.multiply(2),n,arguments)},_readEllipse:function(t){var e,n;if(r.hasNamed(t,"radius"))e=c.readNamed(t,"center"),n=d.readNamed(t,"radius");else{var i=g.readNamed(t,"rectangle");e=i.getCenter(!0),n=i.getSize(!0).divide(2)}return{center:e,radius:n}}}}}),S=w.extend({_class:"Raster",_applyMatrix:!1,_canApplyMatrix:!1,_boundsOptions:{stroke:!1,handle:!1},_serializeFields:{crossOrigin:null,source:null},_prioritize:["crossOrigin"],initialize:function(t,n){if(!this._initialize(t,n!==e&&c.read(arguments,1))){var r="string"==typeof t?i.getElementById(t):t;r?this.setImage(r):this.setSource(t)}this._size||(this._size=new d,this._loaded=!1)},_equals:function(t){return this.getSource()===t.getSource()},copyContent:function(t){var e=t._image,n=t._canvas;if(e)this._setImage(e);else if(n){var i=tt.getCanvas(t._size);i.getContext("2d").drawImage(n,0,0),this._setImage(i)}this._crossOrigin=t._crossOrigin},getSize:function(){var t=this._size;return new _(t?t.width:0,t?t.height:0,this,"setSize")},setSize:function(){var t=d.read(arguments);if(!t.equals(this._size))if(t.width>0&&t.height>0){var e=this.getElement();this._setImage(tt.getCanvas(t)),e&&this.getContext(!0).drawImage(e,0,0,t.width,t.height)}else this._canvas&&tt.release(this._canvas),this._size=t.clone()},getWidth:function(){return this._size?this._size.width:0},setWidth:function(t){this.setSize(t,this.getHeight())},getHeight:function(){return this._size?this._size.height:0},setHeight:function(t){this.setSize(this.getWidth(),t)},getLoaded:function(){return this._loaded},isEmpty:function(){var t=this._size;return!t||0===t.width&&0===t.height},getResolution:function(){var t=this._matrix,e=new c(0,0).transform(t),n=new c(1,0).transform(t).subtract(e),i=new c(0,1).transform(t).subtract(e);return new d(72/n.getLength(),72/i.getLength())},getPpi:"#getResolution",getImage:function(){return this._image},setImage:function(t){function e(t){var e=n.getView(),i=t&&t.type||"load";e&&n.responds(i)&&(paper=e._scope,n.emit(i,new $(t)))}var n=this;this._setImage(t),this._loaded?setTimeout(e,0):t&&H.add(t,{load:function(i){n._setImage(t),e(i)},error:e})},_setImage:function(t){this._canvas&&tt.release(this._canvas),t&&t.getContext?(this._image=null,this._canvas=t,this._loaded=!0):(this._image=t,this._canvas=null,this._loaded=!!(t&&t.src&&t.complete)),this._size=new d(t?t.naturalWidth||t.width:0,t?t.naturalHeight||t.height:0),this._context=null,this._changed(521)},getCanvas:function(){if(!this._canvas){var t=tt.getContext(this._size);try{this._image&&t.drawImage(this._image,0,0),this._canvas=t.canvas}catch(e){tt.release(t)}}return this._canvas},setCanvas:"#setImage",getContext:function(t){return this._context||(this._context=this.getCanvas().getContext("2d")),t&&(this._image=null,this._changed(513)),this._context},setContext:function(t){this._context=t},getSource:function(){var t=this._image;return t&&t.src||this.toDataURL()},setSource:function(e){var n=new t.Image,i=this._crossOrigin;i&&(n.crossOrigin=i),n.src=e,this.setImage(n)},getCrossOrigin:function(){var t=this._image;return t&&t.crossOrigin||this._crossOrigin||""},setCrossOrigin:function(t){this._crossOrigin=t;var e=this._image;e&&(e.crossOrigin=t)},getElement:function(){return this._canvas||this._loaded&&this._image}},{beans:!1,getSubCanvas:function(){var t=g.read(arguments),e=tt.getContext(t.getSize());return e.drawImage(this.getCanvas(),t.x,t.y,t.width,t.height,0,0,t.width,t.height),e.canvas},getSubRaster:function(){var t=g.read(arguments),e=new S(w.NO_INSERT);return e._setImage(this.getSubCanvas(t)),e.translate(t.getCenter().subtract(this.getSize().divide(2))),e._matrix.prepend(this._matrix),e.insertAbove(this),e},toDataURL:function(){var t=this._image,e=t&&t.src;if(/^data:/.test(e))return e;var n=this.getCanvas();return n?n.toDataURL.apply(n,arguments):null},drawImage:function(t){var e=c.read(arguments,1);this.getContext(!0).drawImage(t,e.x,e.y)},getAverageColor:function(t){var e,n;if(t?t instanceof O?(n=t,e=t.getBounds()):"object"==typeof t&&("width"in t?e=new g(t):"x"in t&&(e=new g(t.x-.5,t.y-.5,1,1))):e=this.getBounds(),!e)return null;var i=32,s=Math.min(e.width,i),a=Math.min(e.height,i),o=S._sampleContext;o?o.clearRect(0,0,i+1,i+1):o=S._sampleContext=tt.getContext(new d(i)),o.save();var h=(new p).scale(s/e.width,a/e.height).translate(-e.x,-e.y);h.applyToContext(o),n&&n.draw(o,new r({clip:!0,matrices:[h]})),this._matrix.applyToContext(o);var u=this.getElement(),l=this._size;u&&o.drawImage(u,-l.width/2,-l.height/2),o.restore();for(var c=o.getImageData(.5,.5,Math.ceil(s),Math.ceil(a)).data,f=[0,0,0],_=0,v=0,m=c.length;v<m;v+=4){var y=c[v+3];_+=y,y/=255,f[0]+=c[v]*y,f[1]+=c[v+1]*y,f[2]+=c[v+2]*y}for(var v=0;v<3;v++)f[v]/=_;return _?D.read(f):null},getPixel:function(){var t=c.read(arguments),e=this.getContext().getImageData(t.x,t.y,1,1).data;return new D("rgb",[e[0]/255,e[1]/255,e[2]/255],e[3]/255)},setPixel:function(){var t=c.read(arguments),e=D.read(arguments),n=e._convert("rgb"),i=e._alpha,r=this.getContext(!0),s=r.createImageData(1,1),a=s.data;a[0]=255*n[0],a[1]=255*n[1],a[2]=255*n[2],a[3]=null!=i?255*i:255,r.putImageData(s,t.x,t.y)},createImageData:function(){var t=d.read(arguments);return this.getContext().createImageData(t.width,t.height)},getImageData:function(){var t=g.read(arguments);return t.isEmpty()&&(t=new g(this._size)),this.getContext().getImageData(t.x,t.y,t.width,t.height)},setImageData:function(t){var e=c.read(arguments,1);this.getContext(!0).putImageData(t,e.x,e.y)},_getBounds:function(t,e){var n=new g(this._size).setCenter(0,0);return t?t._transformBounds(n):n},_hitTestSelf:function(t){if(this._contains(t)){var e=this;return new P("pixel",e,{offset:t.add(e._size.divide(2)).round(),color:{get:function(){return e.getPixel(this.offset)}}})}},_draw:function(t){var e=this.getElement();e&&(t.globalAlpha=this._opacity,t.drawImage(e,-this._size.width/2,-this._size.height/2))},_canComposite:function(){return!0}}),k=w.extend({_class:"SymbolItem",_applyMatrix:!1,_canApplyMatrix:!1,_boundsOptions:{stroke:!0},_serializeFields:{symbol:null},initialize:function(t,n){this._initialize(t,n!==e&&c.read(arguments,1))||this.setDefinition(t instanceof I?t:new I(t))},_equals:function(t){return this._definition===t._definition},copyContent:function(t){this.setDefinition(t._definition)},getDefinition:function(){return this._definition},setDefinition:function(t){this._definition=t,this._changed(9)},getSymbol:"#getDefinition",setSymbol:"#setDefinition",isEmpty:function(){return this._definition._item.isEmpty()},_getBounds:function(t,e){var n=this._definition._item;return n._getCachedBounds(n._matrix.prepended(t),e)},_hitTestSelf:function(t,e,n){var i=this._definition._item._hitTest(t,e,n);return i&&(i.item=this),i},_draw:function(t,e){this._definition._item.draw(t,e)}}),I=r.extend({_class:"SymbolDefinition",initialize:function(t,e){this._id=l.get(),this.project=paper.project,t&&this.setItem(t,e)},_serialize:function(t,e){return e.add(this,function(){return r.serialize([this._class,this._item],t,!1,e)})},_changed:function(t){8&t&&w._clearBoundsCache(this),1&t&&this.project._changed(t)},getItem:function(){return this._item},setItem:function(t,e){t._symbol&&(t=t.clone()),this._item&&(this._item._symbol=null),this._item=t,t.remove(),t.setSelected(!1),e||t.setPosition(new c),t._symbol=this,this._changed(9)},getDefinition:"#getItem",setDefinition:"#setItem",place:function(t){return new k(this,t)},clone:function(){return new I(this._item.clone(!1))},equals:function(t){return t===this||t&&this._item.equals(t._item)||!1}}),P=r.extend({_class:"HitResult",initialize:function(t,e,n){this.type=t,this.item=e,n&&this.inject(n)},statics:{getOptions:function(t){var e=t&&r.read(t);return r.set({type:null,tolerance:paper.settings.hitTolerance,fill:!e,stroke:!e,segments:!e,handles:!1,ends:!1,position:!1,center:!1,bounds:!1,guides:!1,selected:!1},e)}}}),A=r.extend({_class:"Segment",beans:!0,_selection:0,initialize:function(t,n,i,r,s,a){var o,h,u,l,c=arguments.length;c>0&&(null==t||"object"==typeof t?1===c&&t&&"point"in t?(o=t.point,h=t.handleIn,u=t.handleOut,l=t.selection):(o=t,h=n,u=i,l=r):(o=[t,n],h=i!==e?[i,r]:null,u=s!==e?[s,a]:null)),new M(o,this,"_point"),new M(h,this,"_handleIn"),new M(u,this,"_handleOut"),l&&this.setSelection(l)},_serialize:function(t,e){var n=this._point,i=this._selection,s=i||this.hasHandles()?[n,this._handleIn,this._handleOut]:n;return i&&s.push(i),r.serialize(s,t,!0,e)},_changed:function(t){var e=this._path;if(e){var n,i=e._curves,r=this._index;i&&(t&&t!==this._point&&t!==this._handleIn||!(n=r>0?i[r-1]:e._closed?i[i.length-1]:null)||n._changed(),t&&t!==this._point&&t!==this._handleOut||!(n=i[r])||n._changed()),e._changed(25)}},getPoint:function(){return this._point},setPoint:function(){this._point.set(c.read(arguments))},getHandleIn:function(){return this._handleIn},setHandleIn:function(){this._handleIn.set(c.read(arguments))},getHandleOut:function(){return this._handleOut},setHandleOut:function(){this._handleOut.set(c.read(arguments))},hasHandles:function(){return!this._handleIn.isZero()||!this._handleOut.isZero()},isSmooth:function(){var t=this._handleIn,e=this._handleOut;return!t.isZero()&&!e.isZero()&&t.isCollinear(e)},clearHandles:function(){this._handleIn._set(0,0),this._handleOut._set(0,0)},getSelection:function(){return this._selection},setSelection:function(t){var e=this._selection,n=this._path;this._selection=t=t||0,n&&t!==e&&(n._updateSelection(this,e,t),n._changed(129))},changeSelection:function(t,e){var n=this._selection;this.setSelection(e?n|t:n&~t)},isSelected:function(){return!!(7&this._selection)},setSelected:function(t){this.changeSelection(7,t)},getIndex:function(){return this._index!==e?this._index:null},getPath:function(){return this._path||null},getCurve:function(){var t=this._path,e=this._index;return t?(e>0&&!t._closed&&e===t._segments.length-1&&e--,t.getCurves()[e]||null):null},getLocation:function(){var t=this.getCurve();return t?new z(t,this===t._segment1?0:1):null},getNext:function(){var t=this._path&&this._path._segments;return t&&(t[this._index+1]||this._path._closed&&t[0])||null},smooth:function(t,n,i){var r=t||{},s=r.type,a=r.factor,o=this.getPrevious(),h=this.getNext(),u=(o||this)._point,l=this._point,f=(h||this)._point,d=u.getDistance(l),_=l.getDistance(f);if(s&&"catmull-rom"!==s){if("geometric"!==s)throw new Error("Smoothing method '"+s+"' not supported.");if(o&&h){var g=u.subtract(f),v=a===e?.4:a,p=v*d/(d+_);n||this.setHandleIn(g.multiply(p)),i||this.setHandleOut(g.multiply(p-v))}}else{var m=a===e?.5:a,y=Math.pow(d,m),w=y*y,x=Math.pow(_,m),b=x*x;if(!n&&o){var C=2*b+3*x*y+w,S=3*x*(x+y);this.setHandleIn(0!==S?new c((b*u._x+C*l._x-w*f._x)/S-l._x,(b*u._y+C*l._y-w*f._y)/S-l._y):new c)}if(!i&&h){var C=2*w+3*y*x+b,S=3*y*(y+x);this.setHandleOut(0!==S?new c((w*f._x+C*l._x-b*u._x)/S-l._x,(w*f._y+C*l._y-b*u._y)/S-l._y):new c)}}},getPrevious:function(){var t=this._path&&this._path._segments;return t&&(t[this._index-1]||this._path._closed&&t[t.length-1])||null},isFirst:function(){return!this._index},isLast:function(){var t=this._path;return t&&this._index===t._segments.length-1||!1},reverse:function(){var t=this._handleIn,e=this._handleOut,n=t.clone();t.set(e),e.set(n)},reversed:function(){return new A(this._point,this._handleOut,this._handleIn)},remove:function(){return!!this._path&&!!this._path.removeSegment(this._index)},clone:function(){return new A(this._point,this._handleIn,this._handleOut)},equals:function(t){return t===this||t&&this._class===t._class&&this._point.equals(t._point)&&this._handleIn.equals(t._handleIn)&&this._handleOut.equals(t._handleOut)||!1},toString:function(){var t=["point: "+this._point];return this._handleIn.isZero()||t.push("handleIn: "+this._handleIn),this._handleOut.isZero()||t.push("handleOut: "+this._handleOut),"{ "+t.join(", ")+" }"},transform:function(t){this._transformCoordinates(t,new Array(6),!0),this._changed()},interpolate:function(t,e,n){var i=1-n,r=n,s=t._point,a=e._point,o=t._handleIn,h=e._handleIn,u=e._handleOut,l=t._handleOut;this._point._set(i*s._x+r*a._x,i*s._y+r*a._y,!0),this._handleIn._set(i*o._x+r*h._x,i*o._y+r*h._y,!0),this._handleOut._set(i*l._x+r*u._x,i*l._y+r*u._y,!0),this._changed()},_transformCoordinates:function(t,e,n){var i=this._point,r=n&&this._handleIn.isZero()?null:this._handleIn,s=n&&this._handleOut.isZero()?null:this._handleOut,a=i._x,o=i._y,h=2;return e[0]=a,e[1]=o,r&&(e[h++]=r._x+a,e[h++]=r._y+o),s&&(e[h++]=s._x+a,e[h++]=s._y+o),t&&(t._transformCoordinates(e,e,h/2),a=e[0],o=e[1],n?(i._x=a,i._y=o,h=2,r&&(r._x=e[h++]-a,r._y=e[h++]-o),s&&(s._x=e[h++]-a,s._y=e[h++]-o)):(r||(e[h++]=a,e[h++]=o),s||(e[h++]=a,e[h++]=o))),e}}),M=c.extend({initialize:function(t,n,i){var r,s,a;if(t)if((r=t[0])!==e)s=t[1];else{var o=t;(r=o.x)===e&&(o=c.read(arguments),r=o.x),s=o.y,a=o.slctd}else r=s=0;this._x=r,this._y=s,this._owner=n,n[i]=this,a&&this.setSelected(!0)},_set:function(t,e){return this._x=t,this._y=e,this._owner._changed(this),this},getX:function(){return this._x},setX:function(t){this._x=t,this._owner._changed(this)},getY:function(){return this._y},setY:function(t){this._y=t,this._owner._changed(this)},isZero:function(){var t=u.isZero;return t(this._x)&&t(this._y)},isSelected:function(){return!!(this._owner._selection&this._getSelection())},setSelected:function(t){this._owner.changeSelection(this._getSelection(),t)},_getSelection:function(){var t=this._owner;return this===t._point?1:this===t._handleIn?2:this===t._handleOut?4:0}}),T=r.extend({_class:"Curve",beans:!0,initialize:function(t,e,n,i,r,s,a,o){var h,u,l,c,f,d,_=arguments.length;3===_?(this._path=t,h=e,u=n):_?1===_?"segment1"in t?(h=new A(t.segment1),u=new A(t.segment2)):"point1"in t?(l=t.point1,f=t.handle1,d=t.handle2,c=t.point2):Array.isArray(t)&&(l=[t[0],t[1]],c=[t[6],t[7]],f=[t[2]-t[0],t[3]-t[1]],d=[t[4]-t[6],t[5]-t[7]]):2===_?(h=new A(t),u=new A(e)):4===_?(l=t,f=e,d=n,c=i):8===_&&(l=[t,e],c=[a,o],f=[n-t,i-e],d=[r-a,s-o]):(h=new A,u=new A),this._segment1=h||new A(l,null,f),this._segment2=u||new A(c,d,null)},_serialize:function(t,e){return r.serialize(this.hasHandles()?[this.getPoint1(),this.getHandle1(),this.getHandle2(),this.getPoint2()]:[this.getPoint1(),this.getPoint2()],t,!0,e)},_changed:function(){this._length=this._bounds=e},clone:function(){return new T(this._segment1,this._segment2)},toString:function(){var t=["point1: "+this._segment1._point];return this._segment1._handleOut.isZero()||t.push("handle1: "+this._segment1._handleOut),this._segment2._handleIn.isZero()||t.push("handle2: "+this._segment2._handleIn),t.push("point2: "+this._segment2._point),"{ "+t.join(", ")+" }"},classify:function(){return T.classify(this.getValues())},remove:function(){var t=!1;if(this._path){var e=this._segment2,n=e._handleOut;t=e.remove(),t&&this._segment1._handleOut.set(n)}return t},getPoint1:function(){return this._segment1._point},setPoint1:function(){this._segment1._point.set(c.read(arguments))},getPoint2:function(){return this._segment2._point},setPoint2:function(){this._segment2._point.set(c.read(arguments))},getHandle1:function(){return this._segment1._handleOut},setHandle1:function(){this._segment1._handleOut.set(c.read(arguments))},getHandle2:function(){return this._segment2._handleIn},setHandle2:function(){this._segment2._handleIn.set(c.read(arguments))},getSegment1:function(){return this._segment1},getSegment2:function(){return this._segment2},getPath:function(){return this._path},getIndex:function(){return this._segment1._index},getNext:function(){var t=this._path&&this._path._curves;return t&&(t[this._segment1._index+1]||this._path._closed&&t[0])||null},getPrevious:function(){var t=this._path&&this._path._curves;return t&&(t[this._segment1._index-1]||this._path._closed&&t[t.length-1])||null},isFirst:function(){return!this._segment1._index},isLast:function(){var t=this._path;return t&&this._segment1._index===t._curves.length-1||!1},isSelected:function(){return this.getPoint1().isSelected()&&this.getHandle2().isSelected()&&this.getHandle2().isSelected()&&this.getPoint2().isSelected()},setSelected:function(t){this.getPoint1().setSelected(t),this.getHandle1().setSelected(t),this.getHandle2().setSelected(t),this.getPoint2().setSelected(t)},getValues:function(t){return T.getValues(this._segment1,this._segment2,t)},getPoints:function(){for(var t=this.getValues(),e=[],n=0;n<8;n+=2)e.push(new c(t[n],t[n+1]));return e}},{getLength:function(){return null==this._length&&(this._length=T.getLength(this.getValues(),0,1)),this._length},getArea:function(){return T.getArea(this.getValues())},getLine:function(){return new m(this._segment1._point,this._segment2._point)},getPart:function(t,e){return new T(T.getPart(this.getValues(),t,e))},getPartLength:function(t,e){return T.getLength(this.getValues(),t,e)},divideAt:function(t){return this.divideAtTime(t&&t.curve===this?t.time:this.getTimeAt(t))},divideAtTime:function(t,e){var n=1e-8,i=1-n,r=null;if(t>=n&&t<=i){var s=T.subdivide(this.getValues(),t),a=s[0],o=s[1],h=e||this.hasHandles(),u=this._segment1,l=this._segment2,f=this._path;h&&(u._handleOut._set(a[2]-a[0],a[3]-a[1]),l._handleIn._set(o[4]-o[6],o[5]-o[7]));var d=a[6],_=a[7],g=new A(new c(d,_),h&&new c(a[4]-d,a[5]-_),h&&new c(o[2]-d,o[3]-_));f?(f.insert(u._index+1,g),r=this.getNext()):(this._segment2=g,this._changed(),r=new T(g,l))}return r},splitAt:function(t){var e=this._path;return e?e.splitAt(t):null},splitAtTime:function(t){return this.splitAt(this.getLocationAtTime(t))},divide:function(t,n){return this.divideAtTime(t===e?.5:n?t:this.getTimeAt(t))},split:function(t,n){return this.splitAtTime(t===e?.5:n?t:this.getTimeAt(t))},reversed:function(){return new T(this._segment2.reversed(),this._segment1.reversed())},clearHandles:function(){this._segment1._handleOut._set(0,0),this._segment2._handleIn._set(0,0)},statics:{getValues:function(t,e,n,i){var r=t._point,s=t._handleOut,a=e._handleIn,o=e._point,h=r.x,u=r.y,l=o.x,c=o.y,f=i?[h,u,h,u,l,c,l,c]:[h,u,h+s._x,u+s._y,l+a._x,c+a._y,l,c];return n&&n._transformCoordinates(f,f,4),f},subdivide:function(t,n){var i=t[0],r=t[1],s=t[2],a=t[3],o=t[4],h=t[5],u=t[6],l=t[7];n===e&&(n=.5);var c=1-n,f=c*i+n*s,d=c*r+n*a,_=c*s+n*o,g=c*a+n*h,v=c*o+n*u,p=c*h+n*l,m=c*f+n*_,y=c*d+n*g,w=c*_+n*v,x=c*g+n*p,b=c*m+n*w,C=c*y+n*x;return[[i,r,f,d,m,y,b,C],[b,C,w,x,v,p,u,l]]},getMonoCurves:function(t,e){var n=[],i=e?0:1,r=t[i+0],s=t[i+2],a=t[i+4],o=t[i+6];if(r>=s==s>=a&&s>=a==a>=o||T.isStraight(t))n.push(t);else{var h=3*(s-a)-r+o,l=2*(r+a)-4*s,c=s-r,f=1e-8,d=1-f,_=[],g=u.solveQuadratic(h,l,c,_,f,d);if(g){_.sort();var v=_[0],p=T.subdivide(t,v);n.push(p[0]),g>1&&(v=(_[1]-v)/(1-v),p=T.subdivide(p[1],v),n.push(p[0])),n.push(p[1])}else n.push(t)}return n},solveCubic:function(t,e,n,i,r,s){var a=t[e],o=t[e+2],h=t[e+4],l=t[e+6],c=0;if(!(a<n&&l<n&&o<n&&h<n||a>n&&l>n&&o>n&&h>n)){var f=3*(o-a),d=3*(h-o)-f,_=l-a-f-d;c=u.solveCubic(_,d,f,a-n,i,r,s)}return c},getTimeOf:function(t,e){var n=new c(t[0],t[1]),i=new c(t[6],t[7]),r=1e-12,s=1e-7,a=e.isClose(n,r)?0:e.isClose(i,r)?1:null;if(null===a)for(var o=[e.x,e.y],h=[],u=0;u<2;u++)for(var l=T.solveCubic(t,u,o[u],h,0,1),f=0;f<l;f++){var d=h[f];if(e.isClose(T.getPoint(t,d),s))return d}return e.isClose(n,s)?0:e.isClose(i,s)?1:null},getNearestTime:function(t,e){function n(n){if(n>=0&&n<=1){var i=e.getDistance(T.getPoint(t,n),!0);if(i<d)return d=i,_=n,!0}}if(T.isStraight(t)){var i=t[0],r=t[1],s=t[6],a=t[7],o=s-i,h=a-r,u=o*o+h*h;if(0===u)return 0;var l=((e.x-i)*o+(e.y-r)*h)/u;return l<1e-12?0:l>.999999999999?1:T.getTimeOf(t,new c(i+l*o,r+l*h))}for(var f=100,d=1/0,_=0,g=0;g<=f;g++)n(g/f);for(var v=1/(2*f);v>1e-8;)n(_-v)||n(_+v)||(v/=2);return _},getPart:function(t,e,n){var i=e>n;if(i){var r=e;e=n,n=r}return e>0&&(t=T.subdivide(t,e)[1]),n<1&&(t=T.subdivide(t,(n-e)/(1-e))[0]),i?[t[6],t[7],t[4],t[5],t[2],t[3],t[0],t[1]]:t},isFlatEnough:function(t,e){var n=t[0],i=t[1],r=t[2],s=t[3],a=t[4],o=t[5],h=t[6],u=t[7],l=3*r-2*n-h,c=3*s-2*i-u,f=3*a-2*h-n,d=3*o-2*u-i;return Math.max(l*l,f*f)+Math.max(c*c,d*d)<=16*e*e},getArea:function(t){var e=t[0],n=t[1],i=t[2],r=t[3],s=t[4],a=t[5],o=t[6],h=t[7];return 3*((h-n)*(i+s)-(o-e)*(r+a)+r*(e-s)-i*(n-a)+h*(s+e/3)-o*(a+n/3))/20},getBounds:function(t){for(var e=t.slice(0,2),n=e.slice(),i=[0,0],r=0;r<2;r++)T._addBounds(t[r],t[r+2],t[r+4],t[r+6],r,0,e,n,i);return new g(e[0],e[1],n[0]-e[0],n[1]-e[1])},_addBounds:function(t,e,n,i,r,s,a,o,h){function l(t,e){var n=t-e,i=t+e;n<a[r]&&(a[r]=n),i>o[r]&&(o[r]=i)}s/=2;var c=a[r]-s,f=o[r]+s;if(t<c||e<c||n<c||i<c||t>f||e>f||n>f||i>f)if(e<t!=e<i&&n<t!=n<i)l(t,s),l(i,s);else{var d=3*(e-n)-t+i,_=2*(t+n)-4*e,g=e-t,v=u.solveQuadratic(d,_,g,h),p=1e-8,m=1-p;l(i,0);for(var y=0;y<v;y++){var w=h[y],x=1-w;p<=w&&w<=m&&l(x*x*x*t+3*x*x*w*e+3*x*w*w*n+w*w*w*i,s)}}}}},r.each(["getBounds","getStrokeBounds","getHandleBounds"],function(t){this[t]=function(){this._bounds||(this._bounds={});var e=this._bounds[t];return e||(e=this._bounds[t]=L[t]([this._segment1,this._segment2],!1,this._path)),e.clone()}},{}),r.each({isStraight:function(t,e,n,i){if(e.isZero()&&n.isZero())return!0;var r=i.subtract(t);if(r.isZero())return!1;if(r.isCollinear(e)&&r.isCollinear(n)){var s=new m(t,i),a=1e-7;if(s.getDistance(t.add(e))<a&&s.getDistance(i.add(n))<a){var o=r.dot(r),h=r.dot(e)/o,u=r.dot(n)/o;return h>=0&&h<=1&&u<=0&&u>=-1}}return!1},isLinear:function(t,e,n,i){var r=i.subtract(t).divide(3);return e.equals(r)&&n.negate().equals(r)}},function(t,e){this[e]=function(e){var n=this._segment1,i=this._segment2;return t(n._point,n._handleOut,i._handleIn,i._point,e)},this.statics[e]=function(e,n){var i=e[0],r=e[1],s=e[6],a=e[7];return t(new c(i,r),new c(e[2]-i,e[3]-r),new c(e[4]-s,e[5]-a),new c(s,a),n)}},{statics:{},hasHandles:function(){return!this._segment1._handleOut.isZero()||!this._segment2._handleIn.isZero()},hasLength:function(t){return(!this.getPoint1().equals(this.getPoint2())||this.hasHandles())&&this.getLength()>(t||0)},isCollinear:function(t){return t&&this.isStraight()&&t.isStraight()&&this.getLine().isCollinear(t.getLine())},isHorizontal:function(){return this.isStraight()&&Math.abs(this.getTangentAtTime(.5).y)<1e-8},isVertical:function(){return this.isStraight()&&Math.abs(this.getTangentAtTime(.5).x)<1e-8}}),{beans:!1,getLocationAt:function(t,e){return this.getLocationAtTime(e?t:this.getTimeAt(t))},getLocationAtTime:function(t){return null!=t&&t>=0&&t<=1?new z(this,t):null},getTimeAt:function(t,e){return T.getTimeAt(this.getValues(),t,e)},getParameterAt:"#getTimeAt",getOffsetAtTime:function(t){return this.getPartLength(0,t)},getLocationOf:function(){return this.getLocationAtTime(this.getTimeOf(c.read(arguments)))},getOffsetOf:function(){var t=this.getLocationOf.apply(this,arguments);return t?t.getOffset():null},getTimeOf:function(){return T.getTimeOf(this.getValues(),c.read(arguments))},getParameterOf:"#getTimeOf",getNearestLocation:function(){var t=c.read(arguments),e=this.getValues(),n=T.getNearestTime(e,t),i=T.getPoint(e,n);return new z(this,n,i,null,t.getDistance(i))},getNearestPoint:function(){var t=this.getNearestLocation.apply(this,arguments);return t?t.getPoint():t}},new function(){var t=["getPoint","getTangent","getNormal","getWeightedTangent","getWeightedNormal","getCurvature"];return r.each(t,function(t){this[t+"At"]=function(e,n){var i=this.getValues();return T[t](i,n?e:T.getTimeAt(i,e))},this[t+"AtTime"]=function(e){return T[t](this.getValues(),e)}},{statics:{_evaluateMethods:t}})},new function(){function t(t){var e=t[0],n=t[1],i=t[2],r=t[3],s=t[4],a=t[5],o=t[6],h=t[7],u=9*(i-s)+3*(o-e),l=6*(e+s)-12*i,c=3*(i-e),f=9*(r-a)+3*(h-n),d=6*(n+a)-12*r,_=3*(r-n);return function(t){var e=(u*t+l)*t+c,n=(f*t+d)*t+_;return Math.sqrt(e*e+n*n)}}function n(t,e){return Math.max(2,Math.min(16,Math.ceil(32*Math.abs(e-t))))}function i(t,e,n,i){if(null==e||e<0||e>1)return null;var r=t[0],s=t[1],a=t[2],o=t[3],h=t[4],l=t[5],f=t[6],d=t[7],_=u.isZero;_(a-r)&&_(o-s)&&(a=r,o=s),_(h-f)&&_(l-d)&&(h=f,l=d);var g,v,p=3*(a-r),m=3*(h-a)-p,y=f-r-p-m,w=3*(o-s),x=3*(l-o)-w,b=d-s-w-x;if(0===n)g=0===e?r:1===e?f:((y*e+m)*e+p)*e+r,v=0===e?s:1===e?d:((b*e+x)*e+w)*e+s;else{var C=1e-8,S=1-C;if(e<C?(g=p,v=w):e>S?(g=3*(f-h),v=3*(d-l)):(g=(3*y*e+2*m)*e+p,v=(3*b*e+2*x)*e+w),i){0===g&&0===v&&(e<C||e>S)&&(g=h-a,v=l-o);var k=Math.sqrt(g*g+v*v);k&&(g/=k,v/=k)}if(3===n){var h=6*y*e+2*m,l=6*b*e+2*x,I=Math.pow(g*g+v*v,1.5);g=0!==I?(g*l-v*h)/I:0,v=0}}return 2===n?new c(v,(-g)):new c(g,v)}return{statics:{classify:function(t){
function n(t,n,i){var r=n!==e,s=r&&n>0&&n<1,a=r&&i>0&&i<1;return!r||(s||a)&&("loop"!==t||s&&a)||(t="arch",s=a=!1),{type:t,roots:s||a?s&&a?n<i?[n,i]:[i,n]:[s?n:i]:null}}var i=t[0],r=t[1],s=t[2],a=t[3],o=t[4],h=t[5],l=t[6],c=t[7],f=i*(c-h)+r*(o-l)+l*h-c*o,d=s*(r-c)+a*(l-i)+i*c-r*l,_=o*(a-r)+h*(i-s)+s*r-a*i,g=3*_,v=g-d,p=v-d+f,m=Math.sqrt(p*p+v*v+g*g),y=0!==m?1/m:0,w=u.isZero,x="serpentine";if(p*=y,v*=y,g*=y,w(p))return w(v)?n(w(g)?"line":"quadratic"):n(x,g/(3*v));var b=3*v*v-4*p*g;if(w(b))return n("cusp",v/(2*p));var C=b>0?Math.sqrt(b/3):Math.sqrt(-b),S=2*p;return n(b>0?x:"loop",(v+C)/S,(v-C)/S)},getLength:function(i,r,s,a){if(r===e&&(r=0),s===e&&(s=1),T.isStraight(i)){var o=i;s<1&&(o=T.subdivide(o,s)[0],r/=s),r>0&&(o=T.subdivide(o,r)[1]);var h=o[6]-o[0],l=o[7]-o[1];return Math.sqrt(h*h+l*l)}return u.integrate(a||t(i),r,s,n(r,s))},getTimeAt:function(i,r,s){function a(t){return p+=u.integrate(d,s,t,n(s,t)),s=t,p-r}if(s===e&&(s=r<0?1:0),0===r)return s;var o=Math.abs,h=1e-12,l=r>0,c=l?s:0,f=l?1:s,d=t(i),_=T.getLength(i,c,f,d),g=o(r)-_;if(o(g)<h)return l?f:c;if(g>h)return null;var v=r/_,p=0;return u.findRoot(a,d,s+v,c,f,32,1e-12)},getPoint:function(t,e){return i(t,e,0,!1)},getTangent:function(t,e){return i(t,e,1,!0)},getWeightedTangent:function(t,e){return i(t,e,1,!1)},getNormal:function(t,e){return i(t,e,2,!0)},getWeightedNormal:function(t,e){return i(t,e,2,!1)},getCurvature:function(t,e){return i(t,e,3,!1).x},getPeaks:function(t){var e=t[0],n=t[1],i=t[2],r=t[3],s=t[4],a=t[5],o=t[6],h=t[7],l=-e+3*i-3*s+o,c=3*e-6*i+3*s,f=-3*e+3*i,d=-n+3*r-3*a+h,_=3*n-6*r+3*a,g=-3*n+3*r,v=1e-8,p=1-v,m=[];return u.solveCubic(9*(l*l+d*d),9*(l*c+_*d),2*(c*c+_*_)+3*(f*l+g*d),f*c+_*g,m,v,p),m.sort()}}}},new function(){function t(t,e,n,i,r,s,a){var o=!a&&n.getPrevious()===r,h=!a&&n!==r&&n.getNext()===r,u=1e-8,l=1-u;if(null!==i&&i>=(o?u:0)&&i<=(h?l:1)&&null!==s&&s>=(h?u:0)&&s<=(o?l:1)){var c=new z(n,i,null,a),f=new z(r,s,null,a);c._intersection=f,f._intersection=c,e&&!e(c)||z.insert(t,c,!0)}}function e(r,s,a,o,h,u,l,c,f,d,_,g,v){if(++f>=4096||++c>=40)return f;var p,y,w=1e-9,x=s[0],b=s[1],C=s[6],S=s[7],k=m.getSignedDistance,I=k(x,b,C,S,s[2],s[3]),P=k(x,b,C,S,s[4],s[5]),A=I*P>0?.75:4/9,M=A*Math.min(0,I,P),z=A*Math.max(0,I,P),O=k(x,b,C,S,r[0],r[1]),L=k(x,b,C,S,r[2],r[3]),E=k(x,b,C,S,r[4],r[5]),N=k(x,b,C,S,r[6],r[7]),B=n(O,L,E,N),j=B[0],F=B[1];if(0===I&&0===P&&0===O&&0===L&&0===E&&0===N||null==(p=i(j,F,M,z))||null==(y=i(j.reverse(),F.reverse(),M,z)))return f;var D=d+(_-d)*p,R=d+(_-d)*y;if(Math.max(v-g,R-D)<w){var q=(D+R)/2,V=(g+v)/2;t(h,u,l?o:a,l?V:q,l?a:o,l?q:V)}else if(r=T.getPart(r,p,y),y-p>.8)if(R-D>v-g){var U=T.subdivide(r,.5),q=(D+R)/2;f=e(s,U[0],o,a,h,u,!l,c,f,g,v,D,q),f=e(s,U[1],o,a,h,u,!l,c,f,g,v,q,R)}else{var U=T.subdivide(s,.5),V=(g+v)/2;f=e(U[0],r,o,a,h,u,!l,c,f,g,V,D,R),f=e(U[1],r,o,a,h,u,!l,c,f,V,v,D,R)}else f=v-g>=w?e(s,r,o,a,h,u,!l,c,f,g,v,D,R):e(r,s,a,o,h,u,l,c,f,D,R,g,v);return f}function n(t,e,n,i){var r,s=[0,t],a=[1/3,e],o=[2/3,n],h=[1,i],u=e-(2*t+i)/3,l=n-(t+2*i)/3;if(u*l<0)r=[[s,a,h],[s,o,h]];else{var c=u/l;r=[c>=2?[s,a,h]:c<=.5?[s,o,h]:[s,a,o,h],[s,h]]}return(u||l)<0?r.reverse():r}function i(t,e,n,i){return t[0][1]<n?r(t,!0,n):e[0][1]>i?r(e,!1,i):t[0][0]}function r(t,e,n){for(var i=t[0][0],r=t[0][1],s=1,a=t.length;s<a;s++){var o=t[s][0],h=t[s][1];if(e?h>=n:h<=n)return h===n?o:i+(n-r)*(o-i)/(h-r);i=o,r=h}return null}function s(t,e,n,i,r){var s=u.isZero;if(s(i)&&s(r)){var a=T.getTimeOf(t,new c(e,n));return null===a?[]:[a]}for(var o=Math.atan2(-r,i),h=Math.sin(o),l=Math.cos(o),f=[],d=[],_=0;_<8;_+=2){var g=t[_]-e,v=t[_+1]-n;f.push(g*l-v*h,g*h+v*l)}return T.solveCubic(f,1,0,d,0,1),d}function a(e,n,i,r,a,o,h){for(var u=n[0],l=n[1],c=n[6],f=n[7],d=s(e,u,l,c-u,f-l),_=0,g=d.length;_<g;_++){var v=d[_],p=T.getPoint(e,v),m=T.getTimeOf(n,p);null!==m&&t(a,o,h?r:i,h?m:v,h?i:r,h?v:m)}}function o(e,n,i,r,s,a){var o=m.intersect(e[0],e[1],e[6],e[7],n[0],n[1],n[6],n[7]);o&&t(s,a,i,T.getTimeOf(e,o),r,T.getTimeOf(n,o))}function h(n,i,r,s,h,u){var l=1e-12,f=Math.min,_=Math.max;if(_(n[0],n[2],n[4],n[6])+l>f(i[0],i[2],i[4],i[6])&&f(n[0],n[2],n[4],n[6])-l<_(i[0],i[2],i[4],i[6])&&_(n[1],n[3],n[5],n[7])+l>f(i[1],i[3],i[5],i[7])&&f(n[1],n[3],n[5],n[7])-l<_(i[1],i[3],i[5],i[7])){var g=d(n,i);if(g)for(var v=0;v<2;v++){var p=g[v];t(h,u,r,p[0],s,p[1],!0)}else{var m=T.isStraight(n),y=T.isStraight(i),w=m&&y,x=m&&!y,b=h.length;if((w?o:m||y?a:e)(x?i:n,x?n:i,x?s:r,x?r:s,h,u,x,0,0,0,1,0,1),!w||h.length===b)for(var v=0;v<4;v++){var C=v>>1,S=1&v,k=6*C,I=6*S,P=new c(n[k],n[k+1]),A=new c(i[I],i[I+1]);P.isClose(A,l)&&t(h,u,r,C,s,S)}}}return h}function l(e,n,i,r){var s=T.classify(e);if("loop"===s.type){var a=s.roots;t(i,r,n,a[0],n,a[1])}return i}function f(t,e,n,i,r,s){var a=!e;a&&(e=t);for(var o,u,c=t.length,f=e.length,d=[],_=[],g=0;g<f;g++)d[g]=e[g].getValues(r);for(var g=0;g<c;g++){var v=t[g],p=a?d[g]:v.getValues(i),m=v.getPath();m!==u&&(u=m,o=[],_.push(o)),a&&l(p,v,o,n);for(var y=a?g+1:0;y<f;y++){if(s&&o.length)return o;h(p,d[y],v,e[y],o,n)}}o=[];for(var g=0,w=_.length;g<w;g++)o.push.apply(o,_[g]);return o}function d(t,e){function n(t){var e=t[6]-t[0],n=t[7]-t[1];return e*e+n*n}var i=Math.abs,r=m.getDistance,s=1e-8,a=1e-7,o=T.isStraight(t),h=T.isStraight(e),u=o&&h,l=n(t)<n(e),f=l?e:t,d=l?t:e,_=f[0],g=f[1],v=f[6]-_,p=f[7]-g;if(r(_,g,v,p,d[0],d[1],!0)<a&&r(_,g,v,p,d[6],d[7],!0)<a)!u&&r(_,g,v,p,f[2],f[3],!0)<a&&r(_,g,v,p,f[4],f[5],!0)<a&&r(_,g,v,p,d[2],d[3],!0)<a&&r(_,g,v,p,d[4],d[5],!0)<a&&(o=h=u=!0);else if(u)return null;if(o^h)return null;for(var y=[t,e],w=[],x=0;x<4&&w.length<2;x++){var b=1&x,C=1^b,S=x>>1,k=T.getTimeOf(y[b],new c(y[C][S?6:0],y[C][S?7:1]));if(null!=k){var I=b?[S,k]:[k,S];(!w.length||i(I[0]-w[0][0])>s&&i(I[1]-w[0][1])>s)&&w.push(I)}if(x>2&&!w.length)break}if(2!==w.length)w=null;else if(!u){var P=T.getPart(t,w[0][0],w[1][0]),A=T.getPart(e,w[0][1],w[1][1]);(i(A[2]-P[2])>a||i(A[3]-P[3])>a||i(A[4]-P[4])>a||i(A[5]-P[5])>a)&&(w=null)}return w}return{getIntersections:function(t){var e=this.getValues(),n=t&&t!==this&&t.getValues();return n?h(e,n,this,t,[]):l(e,this,[])},statics:{getOverlaps:d,getIntersections:f,getCurveLineIntersections:s}}}),z=r.extend({_class:"CurveLocation",initialize:function(t,e,n,i,r){if(e>=.99999999){var s=t.getNext();s&&(e=0,t=s)}this._setCurve(t),this._time=e,this._point=n||t.getPointAtTime(e),this._overlap=i,this._distance=r,this._intersection=this._next=this._previous=null},_setCurve:function(t){var e=t._path;this._path=e,this._version=e?e._version:0,this._curve=t,this._segment=null,this._segment1=t._segment1,this._segment2=t._segment2},_setSegment:function(t){this._setCurve(t.getCurve()),this._segment=t,this._time=t===this._segment1?0:1,this._point=t._point.clone()},getSegment:function(){var t=this._segment;if(!t){var e=this.getCurve(),n=this.getTime();0===n?t=e._segment1:1===n?t=e._segment2:null!=n&&(t=e.getPartLength(0,n)<e.getPartLength(n,1)?e._segment1:e._segment2),this._segment=t}return t},getCurve:function(){function t(t){var e=t&&t.getCurve();if(e&&null!=(n._time=e.getTimeOf(n._point)))return n._setCurve(e),e}var e=this._path,n=this;return e&&e._version!==this._version&&(this._time=this._offset=this._curveOffset=this._curve=null),this._curve||t(this._segment)||t(this._segment1)||t(this._segment2.getPrevious())},getPath:function(){var t=this.getCurve();return t&&t._path},getIndex:function(){var t=this.getCurve();return t&&t.getIndex()},getTime:function(){var t=this.getCurve(),e=this._time;return t&&null==e?this._time=t.getTimeOf(this._point):e},getParameter:"#getTime",getPoint:function(){return this._point},getOffset:function(){var t=this._offset;if(null==t){t=0;var e=this.getPath(),n=this.getIndex();if(e&&null!=n)for(var i=e.getCurves(),r=0;r<n;r++)t+=i[r].getLength();this._offset=t+=this.getCurveOffset()}return t},getCurveOffset:function(){var t=this._curveOffset;if(null==t){var e=this.getCurve(),n=this.getTime();this._curveOffset=t=null!=n&&e&&e.getPartLength(0,n)}return t},getIntersection:function(){return this._intersection},getDistance:function(){return this._distance},divide:function(){var t=this.getCurve(),e=t&&t.divideAtTime(this.getTime());return e&&this._setSegment(e._segment1),e},split:function(){var t=this.getCurve(),e=t._path,n=t&&t.splitAtTime(this.getTime());return n&&this._setSegment(e.getLastSegment()),n},equals:function(t,e){var n=this===t;if(!n&&t instanceof z){var i=this.getCurve(),r=t.getCurve(),s=i._path,a=r._path;if(s===a){var o=Math.abs,h=1e-7,u=o(this.getOffset()-t.getOffset()),l=!e&&this._intersection,c=!e&&t._intersection;n=(u<h||s&&o(s.getLength()-u)<h)&&(!l&&!c||l&&c&&l.equals(c,!0))}}return n},toString:function(){var t=[],e=this.getPoint(),n=h.instance;e&&t.push("point: "+e);var i=this.getIndex();null!=i&&t.push("index: "+i);var r=this.getTime();return null!=r&&t.push("time: "+n.number(r)),null!=this._distance&&t.push("distance: "+n.number(this._distance)),"{ "+t.join(", ")+" }"},isTouching:function(){var t=this._intersection;if(t&&this.getTangent().isCollinear(t.getTangent())){var e=this.getCurve(),n=t.getCurve();return!(e.isStraight()&&n.isStraight()&&e.getLine().intersect(n.getLine()))}return!1},isCrossing:function(){function t(t,e){var n=t.getValues(),i=T.classify(n).roots||T.getPeaks(n),r=i.length,s=e&&r>1?i[r-1]:r>0?i[0]:.5;d.push(T.getLength(n,e?s:0,e?1:s)/2)}function e(t,e,n){return e<n?t>e&&t<n:t>e||t<n}var n=this._intersection;if(!n)return!1;var i=this.getTime(),r=n.getTime(),s=1e-8,a=1-s,o=i>=s&&i<=a,h=r>=s&&r<=a;if(o&&h)return!this.isTouching();var u=this.getCurve(),l=i<s?u.getPrevious():u,c=n.getCurve(),f=r<s?c.getPrevious():c;if(i>a&&(u=u.getNext()),r>a&&(c=c.getNext()),!(l&&u&&f&&c))return!1;var d=[];o||(t(l,!0),t(u,!1)),h||(t(f,!0),t(c,!1));var _=this.getPoint(),g=Math.min.apply(Math,d),v=o?u.getTangentAtTime(i):u.getPointAt(g).subtract(_),p=o?v.negate():l.getPointAt(-g).subtract(_),m=h?c.getTangentAtTime(r):c.getPointAt(g).subtract(_),y=h?m.negate():f.getPointAt(-g).subtract(_),w=p.getAngle(),x=v.getAngle(),b=y.getAngle(),C=m.getAngle();return!!(o?e(w,b,C)^e(x,b,C)&&e(w,C,b)^e(x,C,b):e(b,w,x)^e(C,w,x)&&e(b,x,w)^e(C,x,w))},hasOverlap:function(){return!!this._overlap}},r.each(T._evaluateMethods,function(t){var e=t+"At";this[t]=function(){var t=this.getCurve(),n=this.getTime();return null!=n&&t&&t[e](n,!0)}},{preserve:!0}),new function(){function t(t,e,n){function i(n,i){for(var s=n+i;s>=-1&&s<=r;s+=i){var a=t[(s%r+r)%r];if(!e.getPoint().isClose(a.getPoint(),1e-7))break;if(e.equals(a))return a}return null}for(var r=t.length,s=0,a=r-1;s<=a;){var o,h=s+a>>>1,u=t[h];if(n&&(o=e.equals(u)?u:i(h,-1)||i(h,1)))return e._overlap&&(o._overlap=o._intersection._overlap=!0),o;var l=e.getPath(),c=u.getPath(),f=l!==c?l._id-c._id:e.getIndex()+e.getTime()-(u.getIndex()+u.getTime());f<0?a=h-1:s=h+1}return t.splice(s,0,e),e}return{statics:{insert:t,expand:function(e){for(var n=e.slice(),i=e.length-1;i>=0;i--)t(n,e[i]._intersection,!1);return n}}}}),O=w.extend({_class:"PathItem",_selectBounds:!1,_canScaleStroke:!0,beans:!0,initialize:function(){},statics:{create:function(t){var e,n,i;if(r.isPlainObject(t)?(n=t.segments,e=t.pathData):Array.isArray(t)?n=t:"string"==typeof t&&(e=t),n){var s=n[0];i=s&&Array.isArray(s[0])}else e&&(i=(e.match(/m/gi)||[]).length>1||/z\s*\S+/i.test(e));var a=i?E:L;return new a(t)}},_asPathItem:function(){return this},isClockwise:function(){return this.getArea()>=0},setClockwise:function(t){this.isClockwise()!=(t=!!t)&&this.reverse()},setPathData:function(t){function e(t,e){var n=+i[t];return o&&(n+=h[e]),n}function n(t){return new c(e(t,"x"),e(t+1,"y"))}var i,r,s,a=t&&t.match(/[mlhvcsqtaz][^mlhvcsqtaz]*/gi),o=!1,h=new c,u=new c;this.clear();for(var l=0,f=a&&a.length;l<f;l++){var _=a[l],g=_[0],v=g.toLowerCase();i=_.match(/[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g);var p=i&&i.length;switch(o=g===v,"z"!==r||/[mz]/.test(v)||this.moveTo(h),v){case"m":case"l":for(var m="m"===v,y=0;y<p;y+=2)this[m?"moveTo":"lineTo"](h=n(y)),m&&(u=h,m=!1);s=h;break;case"h":case"v":var w="h"===v?"x":"y";h=h.clone();for(var y=0;y<p;y++)h[w]=e(y,w),this.lineTo(h);s=h;break;case"c":for(var y=0;y<p;y+=6)this.cubicCurveTo(n(y),s=n(y+2),h=n(y+4));break;case"s":for(var y=0;y<p;y+=4)this.cubicCurveTo(/[cs]/.test(r)?h.multiply(2).subtract(s):h,s=n(y),h=n(y+2)),r=v;break;case"q":for(var y=0;y<p;y+=4)this.quadraticCurveTo(s=n(y),h=n(y+2));break;case"t":for(var y=0;y<p;y+=2)this.quadraticCurveTo(s=/[qt]/.test(r)?h.multiply(2).subtract(s):h,h=n(y)),r=v;break;case"a":for(var y=0;y<p;y+=7)this.arcTo(h=n(y+5),new d((+i[y]),(+i[y+1])),+i[y+2],+i[y+4],+i[y+3]);break;case"z":this.closePath(1e-12),h=u}r=v}},_canComposite:function(){return!(this.hasFill()&&this.hasStroke())},_contains:function(t){var e=t.isInside(this.getBounds({internal:!0,handle:!0}))?this._getWinding(t):{};return e.onPath||!!("evenodd"===this.getFillRule()?1&e.windingL||1&e.windingR:e.winding)},getIntersections:function(t,e,n,i){var r=this===t||!t,s=this._matrix._orNullIfIdentity(),a=r?s:(n||t._matrix)._orNullIfIdentity();return r||this.getBounds(s).intersects(t.getBounds(a),1e-12)?T.getIntersections(this.getCurves(),!r&&t.getCurves(),e,s,a,i):[]},getCrossings:function(t){return this.getIntersections(t,function(t){return t.hasOverlap()||t.isCrossing()})},getNearestLocation:function(){for(var t=c.read(arguments),e=this.getCurves(),n=1/0,i=null,r=0,s=e.length;r<s;r++){var a=e[r].getNearestLocation(t);a._distance<n&&(n=a._distance,i=a)}return i},getNearestPoint:function(){var t=this.getNearestLocation.apply(this,arguments);return t?t.getPoint():t},interpolate:function(t,e,n){var i=!this._children,r=i?"_segments":"_children",s=t[r],a=e[r],o=this[r];if(!s||!a||s.length!==a.length)throw new Error("Invalid operands in interpolate() call: "+t+", "+e);var h=o.length,u=a.length;if(h<u)for(var l=i?A:L,c=h;c<u;c++)this.add(new l);else h>u&&this[i?"removeSegments":"removeChildren"](u,h);for(var c=0;c<u;c++)o[c].interpolate(s[c],a[c],n);i&&(this.setClosed(t._closed),this._changed(9))},compare:function(t){var e=!1;if(t){var n=this._children||[this],i=t._children?t._children.slice():[t],r=n.length,s=i.length,a=[],o=0;e=!0;for(var h=r-1;h>=0&&e;h--){var u=n[h];e=!1;for(var l=s-1;l>=0&&!e;l--)u.compare(i[l])&&(a[l]||(a[l]=!0,o++),e=!0)}e=e&&o===s}return e}}),L=O.extend({_class:"Path",_serializeFields:{segments:[],closed:!1},initialize:function(t){this._closed=!1,this._segments=[],this._version=0;var n=Array.isArray(t)?"object"==typeof t[0]?t:arguments:!t||t.size!==e||t.x===e&&t.point===e?null:arguments;n&&n.length>0?this.setSegments(n):(this._curves=e,this._segmentSelection=0,n||"string"!=typeof t||(this.setPathData(t),t=null)),this._initialize(!n&&t)},_equals:function(t){return this._closed===t._closed&&r.equals(this._segments,t._segments)},copyContent:function(t){this.setSegments(t._segments),this._closed=t._closed},_changed:function vt(t){if(vt.base.call(this,t),8&t){if(this._length=this._area=e,16&t)this._version++;else if(this._curves)for(var n=0,i=this._curves.length;n<i;n++)this._curves[n]._changed()}else 32&t&&(this._bounds=e)},getStyle:function(){var t=this._parent;return(t instanceof E?t:this)._style},getSegments:function(){return this._segments},setSegments:function(t){var n=this.isFullySelected(),i=t&&t.length;if(this._segments.length=0,this._segmentSelection=0,this._curves=e,i){var r=t[i-1];"boolean"==typeof r&&(this.setClosed(r),i--),this._add(A.readList(t,0,{},i))}n&&this.setFullySelected(!0)},getFirstSegment:function(){return this._segments[0]},getLastSegment:function(){return this._segments[this._segments.length-1]},getCurves:function(){var t=this._curves,e=this._segments;if(!t){var n=this._countCurves();t=this._curves=new Array(n);for(var i=0;i<n;i++)t[i]=new T(this,e[i],e[i+1]||e[0])}return t},getFirstCurve:function(){return this.getCurves()[0]},getLastCurve:function(){var t=this.getCurves();return t[t.length-1]},isClosed:function(){return this._closed},setClosed:function(t){if(this._closed!=(t=!!t)){if(this._closed=t,this._curves){var e=this._curves.length=this._countCurves();t&&(this._curves[e-1]=new T(this,this._segments[e-1],this._segments[0]))}this._changed(25)}}},{beans:!0,getPathData:function(t,e){function n(e,n){if(e._transformCoordinates(t,g),i=g[0],r=g[1],v)p.push("M"+_.pair(i,r)),v=!1;else if(o=g[2],u=g[3],o===i&&u===r&&l===s&&c===a){if(!n){var h=i-s,f=r-a;p.push(0===h?"v"+_.number(f):0===f?"h"+_.number(h):"l"+_.pair(h,f))}}else p.push("c"+_.pair(l-s,c-a)+" "+_.pair(o-s,u-a)+" "+_.pair(i-s,r-a));s=i,a=r,l=g[4],c=g[5]}var i,r,s,a,o,u,l,c,f=this._segments,d=f.length,_=new h(e),g=new Array(6),v=!0,p=[];if(!d)return"";for(var m=0;m<d;m++)n(f[m]);return this._closed&&d>0&&(n(f[0],!0),p.push("z")),p.join("")},isEmpty:function(){return!this._segments.length},_transformContent:function(t){for(var e=this._segments,n=new Array(6),i=0,r=e.length;i<r;i++)e[i]._transformCoordinates(t,n,!0);return!0},_add:function(t,e){for(var n=this._segments,i=this._curves,r=t.length,s=null==e,e=s?n.length:e,a=0;a<r;a++){var o=t[a];o._path&&(o=t[a]=o.clone()),o._path=this,o._index=e+a,o._selection&&this._updateSelection(o,0,o._selection)}if(s)n.push.apply(n,t);else{n.splice.apply(n,[e,0].concat(t));for(var a=e+r,h=n.length;a<h;a++)n[a]._index=a}if(i){var u=this._countCurves(),l=e>0&&e+r-1===u?e-1:e,c=l,f=Math.min(l+r,u);t._curves&&(i.splice.apply(i,[l,0].concat(t._curves)),c+=t._curves.length);for(var a=c;a<f;a++)i.splice(a,0,new T(this,null,null));this._adjustCurves(l,f)}return this._changed(25),t},_adjustCurves:function(t,e){for(var n,i=this._segments,r=this._curves,s=t;s<e;s++)n=r[s],n._path=this,n._segment1=i[s],n._segment2=i[s+1]||i[0],n._changed();(n=r[this._closed&&!t?i.length-1:t-1])&&(n._segment2=i[t]||i[0],n._changed()),(n=r[e])&&(n._segment1=i[e],n._changed())},_countCurves:function(){var t=this._segments.length;return!this._closed&&t>0?t-1:t},add:function(t){return arguments.length>1&&"number"!=typeof t?this._add(A.readList(arguments)):this._add([A.read(arguments)])[0]},insert:function(t,e){return arguments.length>2&&"number"!=typeof e?this._add(A.readList(arguments,1),t):this._add([A.read(arguments,1)],t)[0]},addSegment:function(){return this._add([A.read(arguments)])[0]},insertSegment:function(t){return this._add([A.read(arguments,1)],t)[0]},addSegments:function(t){return this._add(A.readList(t))},insertSegments:function(t,e){return this._add(A.readList(e),t)},removeSegment:function(t){return this.removeSegments(t,t+1)[0]||null},removeSegments:function(t,e,n){t=t||0,e=r.pick(e,this._segments.length);var i=this._segments,s=this._curves,a=i.length,o=i.splice(t,e-t),h=o.length;if(!h)return o;for(var u=0;u<h;u++){var l=o[u];l._selection&&this._updateSelection(l,l._selection,0),l._index=l._path=null}for(var u=t,c=i.length;u<c;u++)i[u]._index=u;if(s){for(var f=t>0&&e===a+(this._closed?1:0)?t-1:t,s=s.splice(f,h),u=s.length-1;u>=0;u--)s[u]._path=null;n&&(o._curves=s.slice(1)),this._adjustCurves(f,f)}return this._changed(25),o},clear:"#removeSegments",hasHandles:function(){for(var t=this._segments,e=0,n=t.length;e<n;e++)if(t[e].hasHandles())return!0;return!1},clearHandles:function(){for(var t=this._segments,e=0,n=t.length;e<n;e++)t[e].clearHandles()},getLength:function(){if(null==this._length){for(var t=this.getCurves(),e=0,n=0,i=t.length;n<i;n++)e+=t[n].getLength();this._length=e}return this._length},getArea:function(){var t=this._area;if(null==t){var e=this._segments,n=this._closed;t=0;for(var i=0,r=e.length;i<r;i++){var s=i+1===r;t+=T.getArea(T.getValues(e[i],e[s?0:i+1],null,s&&!n))}this._area=t}return t},isFullySelected:function(){var t=this._segments.length;return this.isSelected()&&t>0&&this._segmentSelection===7*t},setFullySelected:function(t){t&&this._selectSegments(!0),this.setSelected(t)},setSelection:function pt(t){1&t||this._selectSegments(!1),pt.base.call(this,t)},_selectSegments:function(t){var e=this._segments,n=e.length,i=t?7:0;this._segmentSelection=i*n;for(var r=0;r<n;r++)e[r]._selection=i},_updateSelection:function(t,e,n){t._selection=n;var i=this._segmentSelection+=n-e;i>0&&this.setSelected(!0)},divideAt:function(t){var e,n=this.getLocationAt(t);return n&&(e=n.getCurve().divideAt(n.getCurveOffset()))?e._segment1:null},splitAt:function(t){var e=this.getLocationAt(t),n=e&&e.index,i=e&&e.time,r=1e-8,s=1-r;i>s&&(n++,i=0);var a=this.getCurves();if(n>=0&&n<a.length){i>=r&&a[n++].divideAtTime(i);var o,h=this.removeSegments(n,this._segments.length,!0);return this._closed?(this.setClosed(!1),o=this):(o=new L(w.NO_INSERT),o.insertAbove(this),o.copyAttributes(this)),o._add(h,0),this.addSegment(h[0]),o}return null},split:function(t,n){var i,r=n===e?t:(i=this.getCurves()[t])&&i.getLocationAtTime(n);return null!=r?this.splitAt(r):null},join:function(t,e){var n=e||0;if(t&&t!==this){var i=t._segments,r=this.getLastSegment(),s=t.getLastSegment();if(!s)return this;r&&r._point.isClose(s._point,n)&&t.reverse();var a=t.getFirstSegment();if(r&&r._point.isClose(a._point,n))r.setHandleOut(a._handleOut),this._add(i.slice(1));else{var o=this.getFirstSegment();o&&o._point.isClose(a._point,n)&&t.reverse(),s=t.getLastSegment(),o&&o._point.isClose(s._point,n)?(o.setHandleIn(s._handleIn),this._add(i.slice(0,i.length-1),0)):this._add(i.slice())}t._closed&&this._add([i[0]]),t.remove()}var h=this.getFirstSegment(),u=this.getLastSegment();return h!==u&&h._point.isClose(u._point,n)&&(h.setHandleIn(u._handleIn),u.remove(),this.setClosed(!0)),this},reduce:function(t){for(var e=this.getCurves(),n=t&&t.simplify,i=n?1e-7:0,r=e.length-1;r>=0;r--){var s=e[r];!s.hasHandles()&&(!s.hasLength(i)||n&&s.isCollinear(s.getNext()))&&s.remove()}return this},reverse:function(){this._segments.reverse();for(var t=0,e=this._segments.length;t<e;t++){var n=this._segments[t],i=n._handleIn;n._handleIn=n._handleOut,n._handleOut=i,n._index=t}this._curves=null,this._changed(9)},flatten:function(t){for(var e=new N(this,t||.25,256,(!0)),n=e.parts,i=n.length,r=[],s=0;s<i;s++)r.push(new A(n[s].curve.slice(0,2)));!this._closed&&i>0&&r.push(new A(n[i-1].curve.slice(6))),this.setSegments(r)},simplify:function(t){var e=new B(this).fit(t||2.5);return e&&this.setSegments(e),!!e},smooth:function(t){function n(t,e){var n=t&&t.index;if(null!=n){var r=t.path;if(r&&r!==i)throw new Error(t._class+" "+n+" of "+r+" is not part of "+i);e&&t instanceof T&&n++}else n="number"==typeof t?t:e;return Math.min(n<0&&h?n%o:n<0?n+o:n,o-1)}var i=this,r=t||{},s=r.type||"asymmetric",a=this._segments,o=a.length,h=this._closed,u=h&&r.from===e&&r.to===e,l=n(r.from,0),c=n(r.to,o-1);if(l>c)if(h)l-=o;else{var f=l;l=c,c=f}if(/^(?:asymmetric|continuous)$/.test(s)){var d="asymmetric"===s,_=Math.min,g=c-l+1,v=g-1,p=u?_(g,4):1,m=p,y=p,w=[];if(h||(m=_(1,l),y=_(1,o-c-1)),v+=m+y,v<=1)return;for(var x=0,b=l-m;x<=v;x++,b++)w[x]=a[(b<0?b+o:b)%o]._point;for(var C=w[0]._x+2*w[1]._x,S=w[0]._y+2*w[1]._y,k=2,I=v-1,P=[C],A=[S],M=[k],z=[],O=[],x=1;x<v;x++){var L=x<I,E=L?1:d?1:2,N=L?4:d?2:7,B=L?4:d?3:8,j=L?2:d?0:1,F=E/k;k=M[x]=N-F,C=P[x]=B*w[x]._x+j*w[x+1]._x-F*C,S=A[x]=B*w[x]._y+j*w[x+1]._y-F*S}z[I]=P[I]/M[I],O[I]=A[I]/M[I];for(var x=v-2;x>=0;x--)z[x]=(P[x]-z[x+1])/M[x],O[x]=(A[x]-O[x+1])/M[x];z[v]=(3*w[v]._x-z[I])/2,O[v]=(3*w[v]._y-O[I])/2;for(var x=m,D=v-y,b=l;x<=D;x++,b++){var R=a[b<0?b+o:b],q=R._point,V=z[x]-q._x,U=O[x]-q._y;(u||x<D)&&R.setHandleOut(V,U),(u||x>m)&&R.setHandleIn(-V,-U)}}else for(var x=l;x<=c;x++)a[x<0?x+o:x].smooth(r,!u&&x===l,!u&&x===c)},toShape:function(t){function n(t,e){var n=c[t],i=n.getNext(),r=c[e],s=r.getNext();return n._handleOut.isZero()&&i._handleIn.isZero()&&r._handleOut.isZero()&&s._handleIn.isZero()&&i._point.subtract(n._point).isCollinear(s._point.subtract(r._point))}function i(t){var e=c[t],n=e.getPrevious(),i=e.getNext();return n._handleOut.isZero()&&e._handleIn.isZero()&&e._handleOut.isZero()&&i._handleIn.isZero()&&e._point.subtract(n._point).isOrthogonal(i._point.subtract(e._point))}function r(t){var e=c[t],n=e.getNext(),i=e._handleOut,r=n._handleIn,s=.5522847498307936;if(i.isOrthogonal(r)){var a=e._point,o=n._point,h=new m(a,i,(!0)).intersect(new m(o,r,(!0)),!0);return h&&u.isZero(i.getLength()/h.subtract(a).getLength()-s)&&u.isZero(r.getLength()/h.subtract(o).getLength()-s)}return!1}function s(t,e){return c[t]._point.getDistance(c[e]._point)}if(!this._closed)return null;var a,o,h,l,c=this._segments;if(!this.hasHandles()&&4===c.length&&n(0,2)&&n(1,3)&&i(1)?(a=C.Rectangle,o=new d(s(0,3),s(0,1)),l=c[1]._point.add(c[2]._point).divide(2)):8===c.length&&r(0)&&r(2)&&r(4)&&r(6)&&n(1,5)&&n(3,7)?(a=C.Rectangle,o=new d(s(1,6),s(0,3)),h=o.subtract(new d(s(0,7),s(1,2))).divide(2),l=c[3]._point.add(c[4]._point).divide(2)):4===c.length&&r(0)&&r(1)&&r(2)&&r(3)&&(u.isZero(s(0,2)-s(1,3))?(a=C.Circle,h=s(0,2)/2):(a=C.Ellipse,h=new d(s(2,0)/2,s(3,1)/2)),l=c[1]._point),a){var f=this.getPosition(!0),_=new a({center:f,size:o,radius:h,insert:!1});return _.copyAttributes(this,!0),_._matrix.prepend(this._matrix),_.rotate(l.subtract(f).getAngle()+90),(t===e||t)&&_.insertAbove(this),_}return null},toPath:"#clone",compare:function mt(t){if(!t||t instanceof E)return mt.base.call(this,t);var e=this.getCurves(),n=t.getCurves(),i=e.length,r=n.length;if(!i||!r)return i==r;for(var s,a,o=e[0].getValues(),h=[],u=0,l=0,c=0;c<r;c++){var f=n[c].getValues();h.push(f);var d=T.getOverlaps(o,f);if(d){s=!c&&d[0][0]>0?r-1:c,a=d[0][1];break}}for(var _,g=Math.abs,v=1e-8,f=h[s];o&&f;){var d=T.getOverlaps(o,f);if(d){var p=d[0][0];if(g(p-l)<v){l=d[1][0],1===l&&(o=++u<i?e[u].getValues():null,l=0);var m=d[0][1];if(g(m-a)<v){if(_||(_=[s,m]),a=d[1][1],1===a&&(++s>=r&&(s=0),f=h[s]||n[s].getValues(),a=0),!o)return _[0]===s&&_[1]===a;continue}}}break}return!1},_hitTestSelf:function(t,e,n,i){function r(e,n){return t.subtract(e).divide(n).length<=1}function s(t,n,i){if(!e.slctd||n.isSelected()){var s=t._point;if(n!==s&&(n=n.add(s)),r(n,x))return new P(i,g,{segment:t,point:n})}}function a(t,n){return(n||e.segments)&&s(t,t._point,"segment")||!n&&e.handles&&(s(t,t._handleIn,"handle-in")||s(t,t._handleOut,"handle-out"))}function o(t){f.add(t)}function h(e){var n=y||e._index>0&&e._index<m-1;if("round"===(n?u:l))return r(e._point,x);if(f=new L({internal:!0,closed:!0}),n?e.isSmooth()||L._addBevelJoin(e,u,k,c,null,i,o,!0):"square"===l&&L._addSquareCap(e,l,k,null,i,o,!0),!f.isEmpty()){var s;return f.contains(t)||(s=f.getNearestLocation(t))&&r(s.getPoint(),w)}}var u,l,c,f,d,_,g=this,v=this.getStyle(),p=this._segments,m=p.length,y=this._closed,w=e._tolerancePadding,x=w,b=e.stroke&&v.hasStroke(),C=e.fill&&v.hasFill(),S=e.curves,k=b?v.getStrokeWidth()/2:C&&e.tolerance>0||S?0:null;if(null!==k&&(k>0?(u=v.getStrokeJoin(),l=v.getStrokeCap(),c=v.getMiterLimit(),x=x.add(L._getStrokePadding(k,i))):u=l="round"),!e.ends||e.segments||y){if(e.segments||e.handles)for(var I=0;I<m;I++)if(_=a(p[I]))return _}else if(_=a(p[0],!0)||a(p[m-1],!0))return _;if(null!==k){if(d=this.getNearestLocation(t)){var A=d.getTime();0===A||1===A&&m>1?h(d.getSegment())||(d=null):r(d.getPoint(),x)||(d=null)}if(!d&&"miter"===u&&m>1)for(var I=0;I<m;I++){var M=p[I];if(t.getDistance(M._point)<=c*k&&h(M)){d=M.getLocation();break}}}return!d&&C&&this._contains(t)||d&&!b&&!S?new P("fill",this):d?new P(b?"stroke":"curve",this,{location:d,point:d.getPoint()}):null}},r.each(T._evaluateMethods,function(t){this[t+"At"]=function(e){var n=this.getLocationAt(e);return n&&n[t]()}},{beans:!1,getLocationOf:function(){for(var t=c.read(arguments),e=this.getCurves(),n=0,i=e.length;n<i;n++){var r=e[n].getLocationOf(t);if(r)return r}return null},getOffsetOf:function(){var t=this.getLocationOf.apply(this,arguments);return t?t.getOffset():null},getLocationAt:function(t){if("number"==typeof t){for(var e=this.getCurves(),n=0,i=0,r=e.length;i<r;i++){var s=n,a=e[i];if(n+=a.getLength(),n>t)return a.getLocationAt(t-s)}if(e.length>0&&t<=this.getLength())return new z(e[e.length-1],1)}else if(t&&t.getPath&&t.getPath()===this)return t;return null}}),new function(){function t(t,e,n,i){function r(e){var n=h[e],i=h[e+1];s==n&&a==i||(t.beginPath(),t.moveTo(s,a),t.lineTo(n,i),t.stroke(),t.beginPath(),t.arc(n,i,o,0,2*Math.PI,!0),t.fill())}for(var s,a,o=i/2,h=new Array(6),u=0,l=e.length;u<l;u++){var c=e[u],f=c._selection;if(c._transformCoordinates(n,h),s=h[0],a=h[1],2&f&&r(2),4&f&&r(4),t.fillRect(s-o,a-o,i,i),!(1&f)){var d=t.fillStyle;t.fillStyle="#ffffff",t.fillRect(s-o+1,a-o+1,i-2,i-2),t.fillStyle=d}}}function e(t,e,n){function i(e){if(n)e._transformCoordinates(n,_),r=_[0],s=_[1];else{var i=e._point;r=i._x,s=i._y}if(g)t.moveTo(r,s),g=!1;else{if(n)h=_[2],u=_[3];else{var f=e._handleIn;h=r+f._x,u=s+f._y}h===r&&u===s&&l===a&&c===o?t.lineTo(r,s):t.bezierCurveTo(l,c,h,u,r,s)}if(a=r,o=s,n)l=_[4],c=_[5];else{var f=e._handleOut;l=a+f._x,c=o+f._y}}for(var r,s,a,o,h,u,l,c,f=e._segments,d=f.length,_=new Array(6),g=!0,v=0;v<d;v++)i(f[v]);e._closed&&d>0&&i(f[0])}return{_draw:function(t,n,i,r){function s(t){return c[(t%f+f)%f]}var a=n.dontStart,o=n.dontFinish||n.clip,h=this.getStyle(),u=h.hasFill(),l=h.hasStroke(),c=h.getDashArray(),f=!paper.support.nativeDash&&l&&c&&c.length;if(a||t.beginPath(),(u||l&&!f||o)&&(e(t,this,r),this._closed&&t.closePath()),!o&&(u||l)&&(this._setStyles(t,n,i),u&&(t.fill(h.getFillRule()),t.shadowColor="rgba(0,0,0,0)"),l)){if(f){a||t.beginPath();var d,_=new N(this,.25,32,(!1),r),g=_.length,v=-h.getDashOffset(),p=0;for(v%=g;v>0;)v-=s(p--)+s(p--);for(;v<g;)d=v+s(p++),(v>0||d>0)&&_.drawPart(t,Math.max(v,0),Math.max(d,0)),v=d+s(p++)}t.stroke()}},_drawSelected:function(n,i){n.beginPath(),e(n,this,i),n.stroke(),t(n,this._segments,i,paper.settings.handleSize)}}},new function(){function t(t){var e=t._segments;if(!e.length)throw new Error("Use a moveTo() command first");return e[e.length-1]}return{moveTo:function(){var t=this._segments;1===t.length&&this.removeSegment(0),t.length||this._add([new A(c.read(arguments))])},moveBy:function(){throw new Error("moveBy() is unsupported on Path items.")},lineTo:function(){this._add([new A(c.read(arguments))])},cubicCurveTo:function(){var e=c.read(arguments),n=c.read(arguments),i=c.read(arguments),r=t(this);r.setHandleOut(e.subtract(r._point)),this._add([new A(i,n.subtract(i))])},quadraticCurveTo:function(){var e=c.read(arguments),n=c.read(arguments),i=t(this)._point;this.cubicCurveTo(e.add(i.subtract(e).multiply(1/3)),e.add(n.subtract(e).multiply(1/3)),n)},curveTo:function(){var e=c.read(arguments),n=c.read(arguments),i=r.pick(r.read(arguments),.5),s=1-i,a=t(this)._point,o=e.subtract(a.multiply(s*s)).subtract(n.multiply(i*i)).divide(2*i*s);if(o.isNaN())throw new Error("Cannot put a curve through points with parameter = "+i);this.quadraticCurveTo(o,n)},arcTo:function(){var e,n,i,s,a,o=Math.abs,h=Math.sqrt,l=t(this),f=l._point,_=c.read(arguments),g=r.peek(arguments),v=r.pick(g,!0);if("boolean"==typeof v)var y=f.add(_).divide(2),e=y.add(y.subtract(f).rotate(v?-90:90));else if(r.remain(arguments)<=2)e=_,_=c.read(arguments);else{var w=d.read(arguments),x=u.isZero;if(x(w.width)||x(w.height))return this.lineTo(_);var b=r.read(arguments),v=!!r.read(arguments),C=!!r.read(arguments),y=f.add(_).divide(2),S=f.subtract(y).rotate(-b),k=S.x,I=S.y,P=o(w.width),M=o(w.height),T=P*P,z=M*M,O=k*k,L=I*I,E=h(O/T+L/z);if(E>1&&(P*=E,M*=E,T=P*P,z=M*M),E=(T*z-T*L-z*O)/(T*L+z*O),o(E)<1e-12&&(E=0),E<0)throw new Error("Cannot create an arc with the given arguments");n=new c(P*I/M,-M*k/P).multiply((C===v?-1:1)*h(E)).rotate(b).add(y),a=(new p).translate(n).rotate(b).scale(P,M),s=a._inverseTransform(f),i=s.getDirectedAngle(a._inverseTransform(_)),!v&&i>0?i-=360:v&&i<0&&(i+=360)}if(e){var N=new m(f.add(e).divide(2),e.subtract(f).rotate(90),(!0)),B=new m(e.add(_).divide(2),_.subtract(e).rotate(90),(!0)),j=new m(f,_),F=j.getSide(e);if(n=N.intersect(B,!0),!n){if(!F)return this.lineTo(_);throw new Error("Cannot create an arc with the given arguments")}s=f.subtract(n),i=s.getDirectedAngle(_.subtract(n));var D=j.getSide(n);0===D?i=F*o(i):F===D&&(i+=i<0?360:-360)}for(var R=1e-7,q=o(i),V=q>=360?4:Math.ceil((q-R)/90),U=i/V,H=U*Math.PI/360,Z=4/3*Math.sin(H)/(1+Math.cos(H)),W=[],$=0;$<=V;$++){var S=_,G=null;if($<V&&(G=s.rotate(90).multiply(Z),a?(S=a._transformPoint(s),G=a._transformPoint(s.add(G)).subtract(S)):S=n.add(s)),$){var J=s.rotate(-90).multiply(Z);
a&&(J=a._transformPoint(s.add(J)).subtract(S)),W.push(new A(S,J,G))}else l.setHandleOut(G);s=s.rotate(U)}this._add(W)},lineBy:function(){var e=c.read(arguments),n=t(this)._point;this.lineTo(n.add(e))},curveBy:function(){var e=c.read(arguments),n=c.read(arguments),i=r.read(arguments),s=t(this)._point;this.curveTo(s.add(e),s.add(n),i)},cubicCurveBy:function(){var e=c.read(arguments),n=c.read(arguments),i=c.read(arguments),r=t(this)._point;this.cubicCurveTo(r.add(e),r.add(n),r.add(i))},quadraticCurveBy:function(){var e=c.read(arguments),n=c.read(arguments),i=t(this)._point;this.quadraticCurveTo(i.add(e),i.add(n))},arcBy:function(){var e=t(this)._point,n=e.add(c.read(arguments)),i=r.pick(r.peek(arguments),!0);"boolean"==typeof i?this.arcTo(n,i):this.arcTo(n,e.add(c.read(arguments)))},closePath:function(t){this.setClosed(!0),this.join(this,t)}}},{_getBounds:function(t,e){var n=e.handle?"getHandleBounds":e.stroke?"getStrokeBounds":"getBounds";return L[n](this._segments,this._closed,this,t,e)},statics:{getBounds:function(t,e,n,i,r,s){function a(t){t._transformCoordinates(i,h);for(var e=0;e<2;e++)T._addBounds(u[e],u[e+4],h[e+2],h[e],e,s?s[e]:0,l,c,f);var n=u;u=h,h=n}var o=t[0];if(!o)return new g;for(var h=new Array(6),u=o._transformCoordinates(i,new Array(6)),l=u.slice(0,2),c=l.slice(),f=new Array(2),d=1,_=t.length;d<_;d++)a(t[d]);return e&&a(o),new g(l[0],l[1],c[0]-l[0],c[1]-l[1])},getStrokeBounds:function(t,e,n,i,r){function s(t){v=v.include(t)}function a(t){v=v.unite(x.setCenter(t._point.transform(i)))}function o(t,e){"round"===e||t.isSmooth()?a(t):L._addBevelJoin(t,e,p,w,i,f,s)}function h(t,e){"round"===e?a(t):L._addSquareCap(t,e,p,i,f,s)}var u=n.getStyle(),l=u.hasStroke(),c=u.getStrokeWidth(),f=l&&n._getStrokeMatrix(i,r),_=l&&L._getStrokePadding(c,f),v=L.getBounds(t,e,n,i,r,_);if(!l)return v;for(var p=c/2,m=u.getStrokeJoin(),y=u.getStrokeCap(),w=u.getMiterLimit(),x=new g(new d(_)),b=t.length-(e?0:1),C=1;C<b;C++)o(t[C],m);return e?o(t[0],m):b>0&&(h(t[0],y),h(t[t.length-1],y)),v},_getStrokePadding:function(t,e){if(!e)return[t,t];var n=new c(t,0).transform(e),i=new c(0,t).transform(e),r=n.getAngleInRadians(),s=n.getLength(),a=i.getLength(),o=Math.sin(r),h=Math.cos(r),u=Math.tan(r),l=Math.atan2(a*u,s),f=Math.atan2(a,u*s);return[Math.abs(s*Math.cos(l)*h+a*Math.sin(l)*o),Math.abs(a*Math.sin(f)*h+s*Math.cos(f)*o)]},_addBevelJoin:function(t,e,n,i,r,s,a,o){var h=t.getCurve(),u=h.getPrevious(),l=h.getPoint1().transform(r),f=u.getNormalAtTime(1).multiply(n).transform(s),d=h.getNormalAtTime(0).multiply(n).transform(s);if(f.getDirectedAngle(d)<0&&(f=f.negate(),d=d.negate()),o&&a(l),a(l.add(f)),"miter"===e){var _=new m(l.add(f),new c((-f.y),f.x),(!0)).intersect(new m(l.add(d),new c((-d.y),d.x),(!0)),!0);_&&l.getDistance(_)<=i*n&&a(_)}a(l.add(d))},_addSquareCap:function(t,e,n,i,r,s,a){var o=t._point.transform(i),h=t.getLocation(),u=h.getNormal().multiply(0===h.getTime()?n:-n).transform(r);"square"===e&&(a&&(s(o.subtract(u)),s(o.add(u))),o=o.add(u.rotate(-90))),s(o.add(u)),s(o.subtract(u))},getHandleBounds:function(t,e,n,i,r){var s,a,o=n.getStyle(),h=r.stroke&&o.hasStroke();if(h){var u=n._getStrokeMatrix(i,r),l=o.getStrokeWidth()/2,c=l;"miter"===o.getStrokeJoin()&&(c=l*o.getMiterLimit()),"square"===o.getStrokeCap()&&(c=Math.max(c,l*Math.SQRT2)),s=L._getStrokePadding(l,u),a=L._getStrokePadding(c,u)}for(var f=new Array(6),d=1/0,_=-d,v=d,p=_,m=0,y=t.length;m<y;m++){var w=t[m];w._transformCoordinates(i,f);for(var x=0;x<6;x+=2){var b=x?s:a,C=b?b[0]:0,S=b?b[1]:0,k=f[x],I=f[x+1],P=k-C,A=k+C,M=I-S,T=I+S;P<d&&(d=P),A>_&&(_=A),M<v&&(v=M),T>p&&(p=T)}}return new g(d,v,_-d,p-v)}}});L.inject({statics:new function(){function t(t,e,n){var i=r.getNamed(n),s=new L(i&&0==i.insert&&w.NO_INSERT);return s._add(t),s._closed=e,s.set(i,{insert:!0})}function e(e,n,r){for(var s=new Array(4),a=0;a<4;a++){var o=i[a];s[a]=new A(o._point.multiply(n).add(e),o._handleIn.multiply(n),o._handleOut.multiply(n))}return t(s,!0,r)}var n=.5522847498307936,i=[new A([-1,0],[0,n],[0,-n]),new A([0,-1],[-n,0],[n,0]),new A([1,0],[0,-n],[0,n]),new A([0,1],[n,0],[-n,0])];return{Line:function(){return t([new A(c.readNamed(arguments,"from")),new A(c.readNamed(arguments,"to"))],!1,arguments)},Circle:function(){var t=c.readNamed(arguments,"center"),n=r.readNamed(arguments,"radius");return e(t,new d(n),arguments)},Rectangle:function(){var e,i=g.readNamed(arguments,"rectangle"),r=d.readNamed(arguments,"radius",0,{readNull:!0}),s=i.getBottomLeft(!0),a=i.getTopLeft(!0),o=i.getTopRight(!0),h=i.getBottomRight(!0);if(!r||r.isZero())e=[new A(s),new A(a),new A(o),new A(h)];else{r=d.min(r,i.getSize(!0).divide(2));var u=r.width,l=r.height,c=u*n,f=l*n;e=[new A(s.add(u,0),null,[-c,0]),new A(s.subtract(0,l),[0,f]),new A(a.add(0,l),null,[0,-f]),new A(a.add(u,0),[-c,0],null),new A(o.subtract(u,0),null,[c,0]),new A(o.add(0,l),[0,-f],null),new A(h.subtract(0,l),null,[0,f]),new A(h.subtract(u,0),[c,0])]}return t(e,!0,arguments)},RoundRectangle:"#Rectangle",Ellipse:function(){var t=C._readEllipse(arguments);return e(t.center,t.radius,arguments)},Oval:"#Ellipse",Arc:function(){var t=c.readNamed(arguments,"from"),e=c.readNamed(arguments,"through"),n=c.readNamed(arguments,"to"),i=r.getNamed(arguments),s=new L(i&&0==i.insert&&w.NO_INSERT);return s.moveTo(t),s.arcTo(e,n),s.set(i)},RegularPolygon:function(){for(var e=c.readNamed(arguments,"center"),n=r.readNamed(arguments,"sides"),i=r.readNamed(arguments,"radius"),s=360/n,a=n%3===0,o=new c(0,a?-i:i),h=a?-1:.5,u=new Array(n),l=0;l<n;l++)u[l]=new A(e.add(o.rotate((l+h)*s)));return t(u,!0,arguments)},Star:function(){for(var e=c.readNamed(arguments,"center"),n=2*r.readNamed(arguments,"points"),i=r.readNamed(arguments,"radius1"),s=r.readNamed(arguments,"radius2"),a=360/n,o=new c(0,(-1)),h=new Array(n),u=0;u<n;u++)h[u]=new A(e.add(o.rotate(a*u).multiply(u%2?s:i)));return t(h,!0,arguments)}}}});var E=O.extend({_class:"CompoundPath",_serializeFields:{children:[]},beans:!0,initialize:function(t){this._children=[],this._namedChildren={},this._initialize(t)||("string"==typeof t?this.setPathData(t):this.addChildren(Array.isArray(t)?t:arguments))},insertChildren:function yt(t,e){var n=e,i=n[0];i&&"number"==typeof i[0]&&(n=[n]);for(var s=e.length-1;s>=0;s--){var a=n[s];n!==e||a instanceof L||(n=r.slice(n)),Array.isArray(a)?n[s]=new L({segments:a,insert:!1}):a instanceof E&&(n.splice.apply(n,[s,1].concat(a.removeChildren())),a.remove())}return yt.base.call(this,t,n)},reduce:function wt(t){for(var e=this._children,n=e.length-1;n>=0;n--){var i=e[n].reduce(t);i.isEmpty()&&i.remove()}if(!e.length){var i=new L(w.NO_INSERT);return i.copyAttributes(this),i.insertAbove(this),this.remove(),i}return wt.base.call(this)},isClosed:function(){for(var t=this._children,e=0,n=t.length;e<n;e++)if(!t[e]._closed)return!1;return!0},setClosed:function(t){for(var e=this._children,n=0,i=e.length;n<i;n++)e[n].setClosed(t)},getFirstSegment:function(){var t=this.getFirstChild();return t&&t.getFirstSegment()},getLastSegment:function(){var t=this.getLastChild();return t&&t.getLastSegment()},getCurves:function(){for(var t=this._children,e=[],n=0,i=t.length;n<i;n++)e.push.apply(e,t[n].getCurves());return e},getFirstCurve:function(){var t=this.getFirstChild();return t&&t.getFirstCurve()},getLastCurve:function(){var t=this.getLastChild();return t&&t.getLastCurve()},getArea:function(){for(var t=this._children,e=0,n=0,i=t.length;n<i;n++)e+=t[n].getArea();return e},getLength:function(){for(var t=this._children,e=0,n=0,i=t.length;n<i;n++)e+=t[n].getLength();return e},getPathData:function(t,e){for(var n=this._children,i=[],r=0,s=n.length;r<s;r++){var a=n[r],o=a._matrix;i.push(a.getPathData(t&&!o.isIdentity()?t.appended(o):t,e))}return i.join("")},_hitTestChildren:function xt(t,e,n){return xt.base.call(this,t,e["class"]===L||"path"===e.type?e:r.set({},e,{fill:!1}),n)},_draw:function(t,e,n,i){var r=this._children;if(r.length){e=e.extend({dontStart:!0,dontFinish:!0}),t.beginPath();for(var s=0,a=r.length;s<a;s++)r[s].draw(t,e,i);if(!e.clip){this._setStyles(t,e,n);var o=this._style;o.hasFill()&&(t.fill(o.getFillRule()),t.shadowColor="rgba(0,0,0,0)"),o.hasStroke()&&t.stroke()}}},_drawSelected:function(t,e,n){for(var i=this._children,r=0,s=i.length;r<s;r++){var a=i[r],o=a._matrix;n[a._id]||a._drawSelected(t,o.isIdentity()?e:e.appended(o))}}},new function(){function t(t,e){var n=t._children;if(e&&!n.length)throw new Error("Use a moveTo() command first");return n[n.length-1]}return r.each(["lineTo","cubicCurveTo","quadraticCurveTo","curveTo","arcTo","lineBy","cubicCurveBy","quadraticCurveBy","curveBy","arcBy"],function(e){this[e]=function(){var n=t(this,!0);n[e].apply(n,arguments)}},{moveTo:function(){var e=t(this),n=e&&e.isEmpty()?e:new L(w.NO_INSERT);n!==e&&this.addChild(n),n.moveTo.apply(n,arguments)},moveBy:function(){var e=t(this,!0),n=e&&e.getLastSegment(),i=c.read(arguments);this.moveTo(n?i.add(n._point):i)},closePath:function(e){t(this,!0).closePath(e)}})},r.each(["reverse","flatten","simplify","smooth"],function(t){this[t]=function(e){for(var n,i=this._children,r=0,s=i.length;r<s;r++)n=i[r][t](e)||n;return n}},{}));O.inject(new function(){function t(t,e){var n=t.clone(!1).reduce({simplify:!0}).transform(null,!0,!0);return e?n.resolveCrossings().reorient("nonzero"===n.getFillRule(),!0):n}function n(t,e,n,i,r){var s=new E(w.NO_INSERT);return s.addChildren(t,!0),s=s.reduce({simplify:e}),r&&0==r.insert||s.insertAbove(i&&n.isSibling(i)&&n.getIndex()<i.getIndex()?i:n),s.copyAttributes(n,!0),s}function i(e,i,r,a){function o(t){for(var e=0,n=t.length;e<n;e++){var i=t[e];w.push.apply(w,i._segments),x.push.apply(x,i.getCurves()),i._overlapsOnly=!0}}if(a&&(0==a.trace||a.stroke)&&/^(subtract|intersect)$/.test(r))return s(e,i,r);var u=t(e,!0),c=i&&e!==i&&t(i,!0),_=p[r];_[r]=!0,c&&(_.subtract||_.exclude)^(c.isClockwise()^u.isClockwise())&&c.reverse();var g,v=l(z.expand(u.getCrossings(c))),m=u._children||[u],y=c&&(c._children||[c]),w=[],x=[];if(v.length){o(m),y&&o(y);for(var b=0,C=v.length;b<C;b++)f(v[b]._segment,u,c,x,_);for(var b=0,C=w.length;b<C;b++){var S=w[b],k=S._intersection;S._winding||f(S,u,c,x,_),k&&k._overlap||(S._path._overlapsOnly=!1)}g=d(w,_)}else g=h(y?m.concat(y):m.slice(),function(t){return!!_[t]});return n(g,!0,e,i,a)}function s(e,i,r){function s(t){if(!c[t._id]&&(l||o.contains(t.getPointAt(t.getLength()/2))^u))return f.unshift(t),c[t._id]=!0}for(var a=t(e),o=t(i),h=a.getCrossings(o),u="subtract"===r,l="divide"===r,c={},f=[],d=h.length-1;d>=0;d--){var _=h[d].split();_&&(s(_)&&_.getFirstSegment().setHandleIn(0,0),a.getLastSegment().setHandleOut(0,0))}return s(a),n(f,!1,e,i)}function a(t,e){for(var n=t;n;){if(n===e)return;n=n._previous}for(;t._next&&t._next!==e;)t=t._next;if(!t._next){for(;e._previous;)e=e._previous;t._next=e,e._previous=t}}function o(t){for(var e=t.length-1;e>=0;e--)t[e].clearHandles()}function h(t,e,n){var i=t&&t.length;if(i){var s=r.each(t,function(t,e){this[t._id]={container:null,winding:t.isClockwise()?1:-1,index:e}},{}),a=t.slice().sort(function(t,e){return v(e.getArea())-v(t.getArea())}),o=a[0];null==n&&(n=o.isClockwise());for(var h=0;h<i;h++){for(var u=a[h],l=s[u._id],c=u.getInteriorPoint(),f=0,d=h-1;d>=0;d--){var _=a[d];if(_.contains(c)){var g=s[_._id];f=g.winding,l.winding+=f,l.container=g.exclude?g.container:_;break}}if(e(l.winding)===e(f))l.exclude=!0,t[l.index]=null;else{var p=l.container;u.setClockwise(p?!p.isClockwise():n)}}}return t}function l(t,e,n){function i(t){return t._path._id+"."+t._segment1._index}for(var r,s,h,u=e&&[],l=1e-8,c=1-l,f=!1,d=n||[],_=n&&{},g=(n&&n.length)-1;g>=0;g--){var v=n[g];v._path&&(_[i(v)]=!0)}for(var g=t.length-1;g>=0;g--){var p,m=t[g],y=m._time,w=y,x=e&&!e(m),v=m._curve;if(v&&(v!==s?(f=!v.hasHandles()||_&&_[i(v)],r=[],h=null,s=v):h>=l&&(y/=h)),x)r&&r.push(m);else{if(e&&u.unshift(m),h=w,y<l)p=v._segment1;else if(y>c)p=v._segment2;else{var b=v.divideAtTime(y,!0);f&&d.push(v,b),p=b._segment1;for(var C=r.length-1;C>=0;C--){var S=r[C];S._time=(S._time-y)/(1-y)}}m._setSegment(p);var k=p._intersection,I=m._intersection;if(k){a(k,I);for(var P=k;P;)a(P._intersection,k),P=P._next}else p._intersection=I}}return n||o(d),u||t}function c(t,e,n,i,r){function s(s){var a=s[l+0],h=s[l+6];if(!(p<_(a,h)||p>g(a,h))){var f=s[u+0],v=s[u+2],m=s[u+4],b=s[u+6];if(a===h)return void((f<x&&b>w||b<x&&f>w)&&(I=!0));var C=p===a?0:p===h?1:w>g(f,v,m,b)||x<_(f,v,m,b)?1:T.solveCubic(s,l,p,M,0,1)>0?M[0]:1,P=0===C?f:1===C?b:T.getPoint(s,C)[n?"y":"x"],z=a>h?1:-1,O=o[l]>o[l+6]?1:-1,L=o[u+6];return p!==a?(P<w?S+=z:P>x?k+=z:I=!0,P>d-y&&P<d+y&&(A/=2)):(z!==O?f<w?S+=z:f>x&&(k+=z):f!=L&&(L<x&&P>x?(k+=z,I=!0):L>w&&P<w&&(S+=z,I=!0)),A=0),o=s,!r&&P>w&&P<x&&0===T.getTangent(s,C)[n?"x":"y"]&&c(t,e,!n,i,!0)}}function a(t){var e=t[l+0],i=t[l+2],r=t[l+4],a=t[l+6];if(p<=g(e,i,r,a)&&p>=_(e,i,r,a))for(var o,h=t[u+0],c=t[u+2],f=t[u+4],d=t[u+6],v=w>g(h,c,f,d)||x<_(h,c,f,d)?[t]:T.getMonoCurves(t,n),m=0,y=v.length;m<y;m++)if(o=s(v[m]))return o}for(var o,h,u=n?1:0,l=1^u,f=[t.x,t.y],d=f[u],p=f[l],m=1e-9,y=1e-6,w=d-m,x=d+m,b=0,C=0,S=0,k=0,I=!1,P=!1,A=1,M=[],z=0,O=e.length;z<O;z++){var L,E=e[z],N=E._path,B=E.getValues();if(!(z&&e[z-1]._path===N||(o=null,N._closed||(h=T.getValues(N.getLastCurve().getSegment2(),E.getSegment1(),null,!i),h[l]!==h[l+6]&&(o=h)),o))){o=B;for(var j=N.getLastCurve();j&&j!==E;){var F=j.getValues();if(F[l]!==F[l+6]){o=F;break}j=j.getPrevious()}}if(L=a(B))return L;if(z+1===O||e[z+1]._path!==N){if(h&&(L=a(h)))return L;!I||S||k||(S=k=N.isClockwise(i)^n?1:-1),b+=S,C+=k,S=k=0,I&&(P=!0,I=!1),h=null}}return b=v(b),C=v(C),{winding:g(b,C),windingL:b,windingR:C,quality:A,onPath:P}}function f(t,e,n,i,r){var s,a=[],o=t,h=0;do{var l=t.getCurve(),f=l.getLength();a.push({segment:t,curve:l,length:f}),h+=f,t=t.getNext()}while(t&&!t._intersection&&t!==o);for(var d=[.5,.25,.75],s={winding:0,quality:-1},_=1e-8,g=1-_,p=0;p<d.length&&s.quality<.5;p++)for(var f=h*d[p],m=0,y=a.length;m<y;m++){var w=a[m],x=w.length;if(f<=x){var l=w.curve,b=l._path,C=b._parent,S=C instanceof E?C:b,k=u.clamp(l.getTimeAt(f),_,g),I=l.getPointAtTime(k),P=v(l.getTangentAtTime(k).y)<Math.SQRT1_2,A=r.subtract&&n&&(S===e&&n._getWinding(I,P,!0).winding||S===n&&!e._getWinding(I,P,!0).winding)?{winding:0,quality:1}:c(I,i,P,!0);A.quality>s.quality&&(s=A);break}f-=x}for(var m=a.length-1;m>=0;m--)a[m].segment._winding=s}function d(t,e){function n(t){var n;return!(!t||t._visited||e&&(!e[(n=t._winding||{}).winding]||e.unite&&2===n.winding&&n.windingL&&n.windingR))}function i(t){if(t)for(var e=0,n=a.length;e<n;e++)if(t===a[e])return!0;return!1}function r(t){for(var e=t._segments,n=0,i=e.length;n<i;n++)e[n]._visited=!0}function s(t,e){function r(r,s){for(;r&&r!==s;){var o=r._segment,u=o._path,l=o.getNext()||u&&u.getFirstSegment(),c=l&&l._intersection;o!==t&&(i(o)||i(l)||l&&n(o)&&(n(l)||c&&n(c._segment)))&&h.push(o),e&&a.push(o),r=r._next}}var s=t._intersection,o=s,h=[];if(e&&(a=[t]),s){for(r(s);s&&s._prev;)s=s._prev;r(s,o)}return h}var a,o=[];t.sort(function(t,e){var n=t._intersection,i=e._intersection,r=!(!n||!n._overlap),s=!(!i||!i._overlap),a=t._path,o=e._path;return r^s?r?1:-1:!n^!i?n?1:-1:a!==o?a._id-o._id:t._index-e._index});for(var h=0,u=t.length;h<u;h++){var l,c,f,d=t[h],_=n(d),g=null,v=!1,p=!0,m=[];if(_&&d._path._overlapsOnly){var y=d._path,x=d._intersection._segment._path;y.compare(x)&&(y.getArea()&&o.push(y.clone(!1)),r(y),r(x),_=!1)}for(;_;){var b=!g,C=s(d,b),S=C.shift(),v=!b&&(i(d)||i(S)),k=!v&&S;if(b&&(g=new L(w.NO_INSERT),l=null),v){(d.isFirst()||d.isLast())&&(p=d._path._closed),d._visited=!0;break}if(k&&l&&(m.push(l),l=null),l||(k&&C.push(d),l={start:g._segments.length,crossings:C,visited:c=[],handleIn:f}),k&&(d=S),!n(d)){g.removeSegments(l.start);for(var I=0,P=c.length;I<P;I++)c[I]._visited=!1;c.length=0;do d=l&&l.crossings.shift(),d||(l=m.pop(),l&&(c=l.visited,f=l.handleIn));while(l&&!n(d));if(!d)break}var M=d.getNext();g.add(new A(d._point,f,M&&d._handleOut)),d._visited=!0,c.push(d),d=M||d._path.getFirstSegment(),f=M&&M._handleIn}v&&(p&&(g.firstSegment.setHandleIn(f),g.setClosed(p)),0!==g.getArea()&&o.push(g))}return o}var _=Math.min,g=Math.max,v=Math.abs,p={unite:{1:!0,2:!0},intersect:{2:!0},subtract:{1:!0},exclude:{1:!0,"-1":!0}};return{_getWinding:function(t,e,n){return c(t,this.getCurves(),e,n)},unite:function(t,e){return i(this,t,"unite",e)},intersect:function(t,e){return i(this,t,"intersect",e)},subtract:function(t,e){return i(this,t,"subtract",e)},exclude:function(t,e){return i(this,t,"exclude",e)},divide:function(t,e){return e&&(0==e.trace||e.stroke)?s(this,t,"divide"):n([this.subtract(t,e),this.intersect(t,e)],!0,this,t,e)},resolveCrossings:function(){function t(t){var e=t&&t._intersection;return e&&e._overlap}var e=this._children,n=e||[this],i=!1,s=!1,a=this.getIntersections(null,function(t){return t.hasOverlap()&&(i=!0)||t.isCrossing()&&(s=!0)}),h=i&&s&&[];if(a=z.expand(a),i)for(var u=l(a,function(t){return t.hasOverlap()},h),c=u.length-1;c>=0;c--){var f=u[c]._segment,_=f.getPrevious(),g=f.getNext();t(_)&&t(g)&&(f.remove(),_._handleOut._set(0,0),g._handleIn._set(0,0),_===f||_.getCurve().hasLength()||(g._handleIn.set(_._handleIn),_.remove()))}s&&(l(a,i&&function(t){var e=t.getCurve(),n=t.getSegment(),i=t._intersection,r=i._curve,s=i._segment;return!!(e&&r&&e._path&&r._path)||(n&&(n._intersection=null),void(s&&(s._intersection=null)))},h),h&&o(h),n=d(r.each(n,function(t){this.push.apply(this,t._segments)},[])));var v,p=n.length;return p>1&&e?(n!==e&&this.setChildren(n),v=this):1!==p||e||(n[0]!==this&&this.setSegments(n[0].removeSegments()),v=this),v||(v=new E(w.NO_INSERT),v.addChildren(n),v=v.reduce(),v.copyAttributes(this),this.replaceWith(v)),v},reorient:function(t,n){var i=this._children;return i&&i.length?this.setChildren(h(this.removeChildren(),function(e){return!!(t?e:1&e)},n)):n!==e&&this.setClockwise(n),this},getInteriorPoint:function(){var t=this.getBounds(),e=t.getCenter(!0);if(!this.contains(e)){for(var n=this.getCurves(),i=e.y,r=[],s=[],a=0,o=n.length;a<o;a++){var h=n[a].getValues(),u=h[1],l=h[3],c=h[5],f=h[7];if(i>=_(u,l,c,f)&&i<=g(u,l,c,f))for(var d=T.getMonoCurves(h),v=0,p=d.length;v<p;v++){var m=d[v],y=m[1],w=m[7];if(y!==w&&(i>=y&&i<=w||i>=w&&i<=y)){var x=i===y?m[0]:i===w?m[6]:1===T.solveCubic(m,1,i,s,0,1)?T.getPoint(m,s[0]).x:(m[0]+m[6])/2;r.push(x)}}}r.length>1&&(r.sort(function(t,e){return t-e}),e.x=(r[0]+r[1])/2)}return e}}});var N=r.extend({_class:"PathFlattener",initialize:function(t,e,n,i,r){function s(t,e){var n=T.getValues(t,e,r);h.push(n),a(n,t._index,0,1)}function a(t,n,r,s){if(!(s-r>c)||i&&T.isStraight(t)||T.isFlatEnough(t,e||.25)){var o=t[6]-t[0],h=t[7]-t[1],f=Math.sqrt(o*o+h*h);f>0&&(l+=f,u.push({offset:l,curve:t,index:n,time:s}))}else{var d=T.subdivide(t,.5),_=(r+s)/2;a(d[0],n,r,_),a(d[1],n,_,s)}}for(var o,h=[],u=[],l=0,c=1/(n||32),f=t._segments,d=f[0],_=1,g=f.length;_<g;_++)o=f[_],s(d,o),d=o;t._closed&&s(o,f[0]),this.curves=h,this.parts=u,this.length=l,this.index=0},_get:function(t){for(var e,n=this.parts,i=n.length,r=this.index;e=r,r&&!(n[--r].offset<t););for(;e<i;e++){var s=n[e];if(s.offset>=t){this.index=e;var a=n[e-1],o=a&&a.index===s.index?a.time:0,h=a?a.offset:0;return{index:s.index,time:o+(s.time-o)*(t-h)/(s.offset-h)}}}return{index:n[i-1].index,time:1}},drawPart:function(t,e,n){for(var i=this._get(e),r=this._get(n),s=i.index,a=r.index;s<=a;s++){var o=T.getPart(this.curves[s],s===i.index?i.time:0,s===r.index?r.time:1);s===i.index&&t.moveTo(o[0],o[1]),t.bezierCurveTo.apply(t,o.slice(2))}}},r.each(T._evaluateMethods,function(t){this[t+"At"]=function(e){var n=this._get(e);return T[t](this.curves[n.index],n.time)}},{})),B=r.extend({initialize:function(t){for(var e,n=this.points=[],i=t._segments,r=t._closed,s=0,a=i.length;s<a;s++){var o=i[s].point;e&&e.equals(o)||n.push(e=o.clone())}r&&(n.unshift(n[n.length-1]),n.push(n[1])),this.closed=r},fit:function(t){var e=this.points,n=e.length,i=null;return n>0&&(i=[new A(e[0])],n>1&&(this.fitCubic(i,t,0,n-1,e[1].subtract(e[0]),e[n-2].subtract(e[n-1])),this.closed&&(i.shift(),i.pop()))),i},fitCubic:function(t,e,n,i,r,s){var a=this.points;if(i-n===1){var o=a[n],h=a[i],u=o.getDistance(h)/3;return void this.addCurve(t,[o,o.add(r.normalize(u)),h.add(s.normalize(u)),h])}for(var l,c=this.chordLengthParameterize(n,i),f=Math.max(e,e*e),d=!0,_=0;_<=4;_++){var g=this.generateBezier(n,i,c,r,s),v=this.findMaxError(n,i,g,c);if(v.error<e&&d)return void this.addCurve(t,g);if(l=v.index,v.error>=f)break;d=this.reparameterize(n,i,c,g),f=v.error}var p=a[l-1].subtract(a[l+1]);this.fitCubic(t,e,n,l,r,p),this.fitCubic(t,e,l,i,p.negate(),s)},addCurve:function(t,e){var n=t[t.length-1];n.setHandleOut(e[1].subtract(e[0])),t.push(new A(e[3],e[2].subtract(e[3])))},generateBezier:function(t,e,n,i,r){for(var s=1e-12,a=Math.abs,o=this.points,h=o[t],u=o[e],l=[[0,0],[0,0]],c=[0,0],f=0,d=e-t+1;f<d;f++){var _=n[f],g=1-_,v=3*_*g,p=g*g*g,m=v*g,y=v*_,w=_*_*_,x=i.normalize(m),b=r.normalize(y),C=o[t+f].subtract(h.multiply(p+m)).subtract(u.multiply(y+w));l[0][0]+=x.dot(x),l[0][1]+=x.dot(b),l[1][0]=l[0][1],l[1][1]+=b.dot(b),c[0]+=x.dot(C),c[1]+=b.dot(C)}var S,k,I=l[0][0]*l[1][1]-l[1][0]*l[0][1];if(a(I)>s){var P=l[0][0]*c[1]-l[1][0]*c[0],A=c[0]*l[1][1]-c[1]*l[0][1];S=A/I,k=P/I}else{var M=l[0][0]+l[0][1],T=l[1][0]+l[1][1];S=k=a(M)>s?c[0]/M:a(T)>s?c[1]/T:0}var z,O,L=u.getDistance(h),E=s*L;if(S<E||k<E)S=k=L/3;else{var N=u.subtract(h);z=i.normalize(S),O=r.normalize(k),z.dot(N)-O.dot(N)>L*L&&(S=k=L/3,z=O=null)}return[h,h.add(z||i.normalize(S)),u.add(O||r.normalize(k)),u]},reparameterize:function(t,e,n,i){for(var r=t;r<=e;r++)n[r-t]=this.findRoot(i,this.points[r],n[r-t]);for(var r=1,s=n.length;r<s;r++)if(n[r]<=n[r-1])return!1;return!0},findRoot:function(t,e,n){for(var i=[],r=[],s=0;s<=2;s++)i[s]=t[s+1].subtract(t[s]).multiply(3);for(var s=0;s<=1;s++)r[s]=i[s+1].subtract(i[s]).multiply(2);var a=this.evaluate(3,t,n),o=this.evaluate(2,i,n),h=this.evaluate(1,r,n),l=a.subtract(e),c=o.dot(o)+l.dot(h);return u.isZero(c)?n:n-l.dot(o)/c},evaluate:function(t,e,n){for(var i=e.slice(),r=1;r<=t;r++)for(var s=0;s<=t-r;s++)i[s]=i[s].multiply(1-n).add(i[s+1].multiply(n));return i[0]},chordLengthParameterize:function(t,e){for(var n=[0],i=t+1;i<=e;i++)n[i-t]=n[i-t-1]+this.points[i].getDistance(this.points[i-1]);for(var i=1,r=e-t;i<=r;i++)n[i]/=n[r];return n},findMaxError:function(t,e,n,i){for(var r=Math.floor((e-t+1)/2),s=0,a=t+1;a<e;a++){var o=this.evaluate(3,n,i[a-t]),h=o.subtract(this.points[a]),u=h.x*h.x+h.y*h.y;u>=s&&(s=u,r=a)}return{error:s,index:r}}}),j=w.extend({_class:"TextItem",_applyMatrix:!1,_canApplyMatrix:!1,_serializeFields:{content:null},_boundsOptions:{stroke:!1,handle:!1},initialize:function(t){this._content="",this._lines=[];var n=t&&r.isPlainObject(t)&&t.x===e&&t.y===e;this._initialize(n&&t,!n&&c.read(arguments))},_equals:function(t){return this._content===t._content},copyContent:function(t){this.setContent(t._content)},getContent:function(){return this._content},setContent:function(t){this._content=""+t,this._lines=this._content.split(/\r\n|\n|\r/gm),this._changed(265)},isEmpty:function(){return!this._content},getCharacterStyle:"#getStyle",setCharacterStyle:"#setStyle",getParagraphStyle:"#getStyle",setParagraphStyle:"#setStyle"}),F=j.extend({_class:"PointText",initialize:function(){j.apply(this,arguments)},getPoint:function(){var t=this._matrix.getTranslation();return new f(t.x,t.y,this,"setPoint")},setPoint:function(){var t=c.read(arguments);this.translate(t.subtract(this._matrix.getTranslation()))},_draw:function(t,e,n){if(this._content){this._setStyles(t,e,n);var i=this._lines,r=this._style,s=r.hasFill(),a=r.hasStroke(),o=r.getLeading(),h=t.shadowColor;t.font=r.getFontStyle(),t.textAlign=r.getJustification();for(var u=0,l=i.length;u<l;u++){t.shadowColor=h;var c=i[u];s&&(t.fillText(c,0,0),t.shadowColor="rgba(0,0,0,0)"),a&&t.strokeText(c,0,0),t.translate(0,o)}}},_getBounds:function(t,e){var n=this._style,i=this._lines,r=i.length,s=n.getJustification(),a=n.getLeading(),o=this.getView().getTextWidth(n.getFontStyle(),i),h=0;"left"!==s&&(h-=o/("center"===s?2:1));var u=new g(h,r?-.75*a:0,o,r*a);return t?t._transformBounds(u,u):u}}),D=r.extend(new function(){function t(t){var i,r=t.match(/^#(\w{1,2})(\w{1,2})(\w{1,2})$/);if(r){i=[0,0,0];for(var s=0;s<3;s++){var o=r[s+1];i[s]=parseInt(1==o.length?o+o:o,16)/255}}else if(r=t.match(/^rgba?\((.*)\)$/)){i=r[1].split(",");for(var s=0,h=i.length;s<h;s++){var o=+i[s];i[s]=s<3?o/255:o}}else if(n){var u=a[t];if(!u){e||(e=tt.getContext(1,1),e.globalCompositeOperation="copy"),e.fillStyle="rgba(0,0,0,0)",e.fillStyle=t,e.fillRect(0,0,1,1);var l=e.getImageData(0,0,1,1).data;u=a[t]=[l[0]/255,l[1]/255,l[2]/255]}i=u.slice()}else i=[0,0,0];return i}var e,i={gray:["gray"],rgb:["red","green","blue"],hsb:["hue","saturation","brightness"],hsl:["hue","saturation","lightness"],gradient:["gradient","origin","destination","highlight"]},s={},a={},o=[[0,3,1],[2,0,1],[1,0,3],[1,2,0],[3,1,0],[0,1,2]],u={"rgb-hsb":function(t,e,n){var i=Math.max(t,e,n),r=Math.min(t,e,n),s=i-r,a=0===s?0:60*(i==t?(e-n)/s+(e<n?6:0):i==e?(n-t)/s+2:(t-e)/s+4);return[a,0===i?0:s/i,i]},"hsb-rgb":function(t,e,n){t=(t/60%6+6)%6;var i=Math.floor(t),r=t-i,i=o[i],s=[n,n*(1-e),n*(1-e*r),n*(1-e*(1-r))];return[s[i[0]],s[i[1]],s[i[2]]]},"rgb-hsl":function(t,e,n){var i=Math.max(t,e,n),r=Math.min(t,e,n),s=i-r,a=0===s,o=a?0:60*(i==t?(e-n)/s+(e<n?6:0):i==e?(n-t)/s+2:(t-e)/s+4),h=(i+r)/2,u=a?0:h<.5?s/(i+r):s/(2-i-r);return[o,u,h]},"hsl-rgb":function(t,e,n){if(t=(t/360%1+1)%1,0===e)return[n,n,n];for(var i=[t+1/3,t,t-1/3],r=n<.5?n*(1+e):n+e-n*e,s=2*n-r,a=[],o=0;o<3;o++){var h=i[o];h<0&&(h+=1),h>1&&(h-=1),a[o]=6*h<1?s+6*(r-s)*h:2*h<1?r:3*h<2?s+(r-s)*(2/3-h)*6:s}return a},"rgb-gray":function(t,e,n){return[.2989*t+.587*e+.114*n]},"gray-rgb":function(t){return[t,t,t]},"gray-hsb":function(t){return[0,0,t]},"gray-hsl":function(t){return[0,0,t]},"gradient-rgb":function(){return[]},"rgb-gradient":function(){return[]}};return r.each(i,function(t,e){s[e]=[],r.each(t,function(t,n){var a=r.capitalize(t),o=/^(hue|saturation)$/.test(t),h=s[e][n]="gradient"===t?function(t){var e=this._components[0];return t=R.read(Array.isArray(t)?t:arguments,0,{readNull:!0}),e!==t&&(e&&e._removeOwner(this),t&&t._addOwner(this)),t}:"gradient"===e?function(){return c.read(arguments,0,{readNull:"highlight"===t,clone:!0})}:function(t){return null==t||isNaN(t)?0:t};this["get"+a]=function(){return this._type===e||o&&/^hs[bl]$/.test(this._type)?this._components[n]:this._convert(e)[n]},this["set"+a]=function(t){this._type===e||o&&/^hs[bl]$/.test(this._type)||(this._components=this._convert(e),this._properties=i[e],this._type=e),this._components[n]=h.call(this,t),this._changed()}},this)},{_class:"Color",_readIndex:!0,initialize:function l(e){var n,a,o,h,u=arguments,c=this.__read,f=0;Array.isArray(e)&&(u=e,e=u[0]);var d=null!=e&&typeof e;if("string"===d&&e in i&&(n=e,e=u[1],Array.isArray(e)?(a=e,o=u[2]):(c&&(f=1),u=r.slice(u,1),d=typeof e)),!a){if(h="number"===d?u:"object"===d&&null!=e.length?e:null){n||(n=h.length>=3?"rgb":"gray");var _=i[n].length;o=h[_],c&&(f+=h===arguments?_+(null!=o?1:0):1),h.length>_&&(h=r.slice(h,0,_))}else if("string"===d)n="rgb",a=t(e),4===a.length&&(o=a[3],a.length--);else if("object"===d)if(e.constructor===l){if(n=e._type,a=e._components.slice(),o=e._alpha,"gradient"===n)for(var g=1,v=a.length;g<v;g++){var p=a[g];p&&(a[g]=p.clone())}}else if(e.constructor===R)n="gradient",h=u;else{n="hue"in e?"lightness"in e?"hsl":"hsb":"gradient"in e||"stops"in e||"radial"in e?"gradient":"gray"in e?"gray":"rgb";var m=i[n],y=s[n];this._components=a=[];for(var g=0,v=m.length;g<v;g++){var w=e[m[g]];null==w&&!g&&"gradient"===n&&"stops"in e&&(w={stops:e.stops,radial:e.radial}),w=y[g].call(this,w),null!=w&&(a[g]=w)}o=e.alpha}c&&n&&(f=1)}if(this._type=n||"rgb",!a){this._components=a=[];for(var y=s[this._type],g=0,v=y.length;g<v;g++){var w=y[g].call(this,h&&h[g]);null!=w&&(a[g]=w)}}return this._components=a,this._properties=i[this._type],this._alpha=o,c&&(this.__read=f),this},set:"#initialize",_serialize:function(t,e){var n=this.getComponents();return r.serialize(/^(gray|rgb)$/.test(this._type)?n:[this._type].concat(n),t,!0,e)},_changed:function(){this._canvasStyle=null,this._owner&&this._owner._changed(65)},_convert:function(t){var e;return this._type===t?this._components.slice():(e=u[this._type+"-"+t])?e.apply(this,this._components):u["rgb-"+t].apply(this,u[this._type+"-rgb"].apply(this,this._components))},convert:function(t){return new D(t,this._convert(t),this._alpha)},getType:function(){return this._type},setType:function(t){this._components=this._convert(t),this._properties=i[t],this._type=t},getComponents:function(){var t=this._components.slice();return null!=this._alpha&&t.push(this._alpha),t},getAlpha:function(){return null!=this._alpha?this._alpha:1},setAlpha:function(t){this._alpha=null==t?null:Math.min(Math.max(t,0),1),this._changed()},hasAlpha:function(){return null!=this._alpha},equals:function(t){var e=r.isPlainValue(t,!0)?D.read(arguments):t;return e===this||e&&this._class===e._class&&this._type===e._type&&this.getAlpha()===e.getAlpha()&&r.equals(this._components,e._components)||!1},toString:function(){for(var t=this._properties,e=[],n="gradient"===this._type,i=h.instance,r=0,s=t.length;r<s;r++){var a=this._components[r];null!=a&&e.push(t[r]+": "+(n?a:i.number(a)))}return null!=this._alpha&&e.push("alpha: "+i.number(this._alpha)),"{ "+e.join(", ")+" }"},toCSS:function(t){function e(t){return Math.round(255*(t<0?0:t>1?1:t))}var n=this._convert("rgb"),i=t||null==this._alpha?1:this._alpha;return n=[e(n[0]),e(n[1]),e(n[2])],i<1&&n.push(i<0?0:i),t?"#"+((1<<24)+(n[0]<<16)+(n[1]<<8)+n[2]).toString(16).slice(1):(4==n.length?"rgba(":"rgb(")+n.join(",")+")"},toCanvasStyle:function(t,e){if(this._canvasStyle)return this._canvasStyle;if("gradient"!==this._type)return this._canvasStyle=this.toCSS();var n,i=this._components,r=i[0],s=r._stops,a=i[1],o=i[2],h=i[3],u=e&&e.inverted();if(u&&(a=u._transformPoint(a),o=u._transformPoint(o),h&&(h=u._transformPoint(h))),r._radial){var l=o.getDistance(a);if(h){var c=h.subtract(a);c.getLength()>l&&(h=a.add(c.normalize(l-.1)))}var f=h||a;n=t.createRadialGradient(f.x,f.y,0,a.x,a.y,l)}else n=t.createLinearGradient(a.x,a.y,o.x,o.y);for(var d=0,_=s.length;d<_;d++){var g=s[d],v=g._offset;n.addColorStop(null==v?d/(_-1):v,g._color.toCanvasStyle())}return this._canvasStyle=n},transform:function(t){if("gradient"===this._type){for(var e=this._components,n=1,i=e.length;n<i;n++){var r=e[n];t._transformPoint(r,r,!0)}this._changed()}},statics:{_types:i,random:function(){var t=Math.random;return new D(t(),t(),t())}}})},new function(){var t={add:function(t,e){return t+e},subtract:function(t,e){return t-e},multiply:function(t,e){return t*e},divide:function(t,e){return t/e}};return r.each(t,function(t,e){this[e]=function(e){e=D.read(arguments);for(var n=this._type,i=this._components,r=e._convert(n),s=0,a=i.length;s<a;s++)r[s]=t(i[s],r[s]);return new D(n,r,null!=this._alpha?t(this._alpha,e.getAlpha()):null)}},{})}),R=r.extend({_class:"Gradient",initialize:function(t,e){this._id=l.get(),t&&r.isPlainObject(t)&&(this.set(t),t=e=null),null==this._stops&&this.setStops(t||["white","black"]),null==this._radial&&this.setRadial("string"==typeof e&&"radial"===e||e||!1)},_serialize:function(t,e){return e.add(this,function(){return r.serialize([this._stops,this._radial],t,!0,e)})},_changed:function(){for(var t=0,e=this._owners&&this._owners.length;t<e;t++)this._owners[t]._changed()},_addOwner:function(t){this._owners||(this._owners=[]),this._owners.push(t)},_removeOwner:function(t){var n=this._owners?this._owners.indexOf(t):-1;n!=-1&&(this._owners.splice(n,1),this._owners.length||(this._owners=e))},clone:function(){for(var t=[],e=0,n=this._stops.length;e<n;e++)t[e]=this._stops[e].clone();return new R(t,this._radial)},getStops:function(){return this._stops},setStops:function(t){if(t.length<2)throw new Error("Gradient stop list needs to contain at least two stops.");var n=this._stops;if(n)for(var i=0,r=n.length;i<r;i++)n[i]._owner=e;n=this._stops=q.readList(t,0,{clone:!0});for(var i=0,r=n.length;i<r;i++)n[i]._owner=this;
this._changed()},getRadial:function(){return this._radial},setRadial:function(t){this._radial=t,this._changed()},equals:function(t){if(t===this)return!0;if(t&&this._class===t._class){var e=this._stops,n=t._stops,i=e.length;if(i===n.length){for(var r=0;r<i;r++)if(!e[r].equals(n[r]))return!1;return!0}}return!1}}),q=r.extend({_class:"GradientStop",initialize:function(t,n){var i=t,r=n;"object"==typeof t&&n===e&&(Array.isArray(t)&&"number"!=typeof t[0]?(i=t[0],r=t[1]):("color"in t||"offset"in t||"rampPoint"in t)&&(i=t.color,r=t.offset||t.rampPoint||0)),this.setColor(i),this.setOffset(r)},clone:function(){return new q(this._color.clone(),this._offset)},_serialize:function(t,e){var n=this._color,i=this._offset;return r.serialize(null==i?[n]:[n,i],t,!0,e)},_changed:function(){this._owner&&this._owner._changed(65)},getOffset:function(){return this._offset},setOffset:function(t){this._offset=t,this._changed()},getRampPoint:"#getOffset",setRampPoint:"#setOffset",getColor:function(){return this._color},setColor:function(){var t=D.read(arguments,0,{clone:!0});t&&(t._owner=this),this._color=t,this._changed()},equals:function(t){return t===this||t&&this._class===t._class&&this._color.equals(t._color)&&this._offset==t._offset||!1}}),V=r.extend(new function(){var t={fillColor:null,fillRule:"nonzero",strokeColor:null,strokeWidth:1,strokeCap:"butt",strokeJoin:"miter",strokeScaling:!0,miterLimit:10,dashOffset:0,dashArray:[],shadowColor:null,shadowBlur:0,shadowOffset:new c,selectedColor:null},n=r.set({},t,{fontFamily:"sans-serif",fontWeight:"normal",fontSize:12,leading:null,justification:"left"}),i=r.set({},n,{fillColor:new D}),s={strokeWidth:97,strokeCap:97,strokeJoin:97,strokeScaling:105,miterLimit:97,fontFamily:9,fontWeight:9,fontSize:9,font:9,leading:9,justification:9},a={beans:!0},o={_class:"Style",beans:!0,initialize:function(e,r,s){this._values={},this._owner=r,this._project=r&&r._project||s||paper.project,this._defaults=!r||r instanceof x?n:r instanceof j?i:t,e&&this.set(e)}};return r.each(n,function(t,n){var i=/Color$/.test(n),h="shadowOffset"===n,u=r.capitalize(n),l=s[n],f="set"+u,d="get"+u;o[f]=function(t){var r=this._owner,s=r&&r._children;if(s&&s.length>0&&!(r instanceof E))for(var a=0,o=s.length;a<o;a++)s[a]._style[f](t);else if(n in this._defaults){var h=this._values[n];h!==t&&(i&&(h&&h._owner!==e&&(h._owner=e),t&&t.constructor===D&&(t._owner&&(t=t.clone()),t._owner=r)),this._values[n]=t,r&&r._changed(l||65))}},o[d]=function(t){var s,a=this._owner,o=a&&a._children;if(n in this._defaults&&(!o||!o.length||t||a instanceof E)){var s=this._values[n];if(s===e)s=this._defaults[n],s&&s.clone&&(s=s.clone());else{var u=i?D:h?c:null;!u||s&&s.constructor===u||(this._values[n]=s=u.read([s],0,{readNull:!0,clone:!0}),s&&i&&(s._owner=a))}}else if(o)for(var l=0,f=o.length;l<f;l++){var _=o[l]._style[d]();if(l){if(!r.equals(s,_))return e}else s=_}return s},a[d]=function(t){return this._style[d](t)},a[f]=function(t){this._style[f](t)}}),r.each({Font:"FontFamily",WindingRule:"FillRule"},function(t,e){var n="get"+e,i="set"+e;o[n]=a[n]="#get"+t,o[i]=a[i]="#set"+t}),w.inject(a),o},{set:function(t){var e=t instanceof V,n=e?t._values:t;if(n)for(var i in n)if(i in this._defaults){var r=n[i];this[i]=r&&e&&r.clone?r.clone():r}},equals:function(t){function n(t,n,i){var s=t._values,a=n._values,o=n._defaults;for(var h in s){var u=s[h],l=a[h];if(!(i&&h in a||r.equals(u,l===e?o[h]:l)))return!1}return!0}return t===this||t&&this._class===t._class&&n(this,t)&&n(t,this,!0)||!1},hasFill:function(){var t=this.getFillColor();return!!t&&t.alpha>0},hasStroke:function(){var t=this.getStrokeColor();return!!t&&t.alpha>0&&this.getStrokeWidth()>0},hasShadow:function(){var t=this.getShadowColor();return!!t&&t.alpha>0&&(this.getShadowBlur()>0||!this.getShadowOffset().isZero())},getView:function(){return this._project._view},getFontStyle:function(){var t=this.getFontSize();return this.getFontWeight()+" "+t+(/[a-z]/i.test(t+"")?" ":"px ")+this.getFontFamily()},getFont:"#getFontFamily",setFont:"#setFontFamily",getLeading:function bt(){var t=bt.base.call(this),e=this.getFontSize();return/pt|em|%|px/.test(e)&&(e=this.getView().getPixelSize(e)),null!=t?t:1.2*e}}),U=new function(){function t(t,e,n,i){for(var r=["","webkit","moz","Moz","ms","o"],s=e[0].toUpperCase()+e.substring(1),a=0;a<6;a++){var o=r[a],h=o?o+s:e;if(h in t){if(!n)return t[h];t[h]=i;break}}}return{getStyles:function(t){var e=t&&9!==t.nodeType?t.ownerDocument:t,n=e&&e.defaultView;return n&&n.getComputedStyle(t,"")},getBounds:function(t,e){var n,i=t.ownerDocument,r=i.body,s=i.documentElement;try{n=t.getBoundingClientRect()}catch(a){n={left:0,top:0,width:0,height:0}}var o=n.left-(s.clientLeft||r.clientLeft||0),h=n.top-(s.clientTop||r.clientTop||0);if(!e){var u=i.defaultView;o+=u.pageXOffset||s.scrollLeft||r.scrollLeft,h+=u.pageYOffset||s.scrollTop||r.scrollTop}return new g(o,h,n.width,n.height)},getViewportBounds:function(t){var e=t.ownerDocument,n=e.defaultView,i=e.documentElement;return new g(0,0,n.innerWidth||i.clientWidth,n.innerHeight||i.clientHeight)},getOffset:function(t,e){return U.getBounds(t,e).getPoint()},getSize:function(t){return U.getBounds(t,!0).getSize()},isInvisible:function(t){return U.getSize(t).equals(new d(0,0))},isInView:function(t){return!U.isInvisible(t)&&U.getViewportBounds(t).intersects(U.getBounds(t,!0))},isInserted:function(t){return i.body.contains(t)},getPrefixed:function(e,n){return e&&t(e,n)},setPrefixed:function(e,n,i){if("object"==typeof n)for(var r in n)t(e,r,!0,n[r]);else t(e,n,!0,i)}}},H={add:function(t,e){if(t)for(var n in e)for(var i=e[n],r=n.split(/[\s,]+/g),s=0,a=r.length;s<a;s++)t.addEventListener(r[s],i,!1)},remove:function(t,e){if(t)for(var n in e)for(var i=e[n],r=n.split(/[\s,]+/g),s=0,a=r.length;s<a;s++)t.removeEventListener(r[s],i,!1)},getPoint:function(t){var e=t.targetTouches?t.targetTouches.length?t.targetTouches[0]:t.changedTouches[0]:t;return new c(e.pageX||e.clientX+i.documentElement.scrollLeft,e.pageY||e.clientY+i.documentElement.scrollTop)},getTarget:function(t){return t.target||t.srcElement},getRelatedTarget:function(t){return t.relatedTarget||t.toElement},getOffset:function(t,e){return H.getPoint(t).subtract(U.getOffset(e||H.getTarget(t)))}};H.requestAnimationFrame=new function(){function t(){var e=s;s=[];for(var n=0,a=e.length;n<a;n++)e[n]();r=i&&s.length,r&&i(t)}var e,i=U.getPrefixed(n,"requestAnimationFrame"),r=!1,s=[];return function(n){s.push(n),i?r||(i(t),r=!0):e||(e=setInterval(t,1e3/60))}};var Z=r.extend(s,{_class:"View",initialize:function Ct(t,e){function r(t){return e[t]||parseInt(e.getAttribute(t),10)}function s(){var t=U.getSize(e);return t.isNaN()||t.isZero()?new d(r("width"),r("height")):t}var o;if(n&&e){this._id=e.getAttribute("id"),null==this._id&&e.setAttribute("id",this._id="view-"+Ct._id++),H.add(e,this._viewEvents);var h="none";if(U.setPrefixed(e.style,{userDrag:h,userSelect:h,touchCallout:h,contentZooming:h,tapHighlightColor:"rgba(0,0,0,0)"}),a.hasAttribute(e,"resize")){var u=this;H.add(n,this._windowEvents={resize:function(){u.setViewSize(s())}})}if(o=s(),a.hasAttribute(e,"stats")&&"undefined"!=typeof Stats){this._stats=new Stats;var l=this._stats.domElement,c=l.style,f=U.getOffset(e);c.position="absolute",c.left=f.x+"px",c.top=f.y+"px",i.body.appendChild(l)}}else o=new d(e),e=null;this._project=t,this._scope=t._scope,this._element=e,this._pixelRatio||(this._pixelRatio=n&&n.devicePixelRatio||1),this._setElementSize(o.width,o.height),this._viewSize=o,Ct._views.push(this),Ct._viewsById[this._id]=this,(this._matrix=new p)._owner=this,Ct._focused||(Ct._focused=this),this._frameItems={},this._frameItemCount=0,this._itemEvents={"native":{},virtual:{}},this._autoUpdate=!paper.agent.node,this._needsUpdate=!1},remove:function(){if(!this._project)return!1;Z._focused===this&&(Z._focused=null),Z._views.splice(Z._views.indexOf(this),1),delete Z._viewsById[this._id];var t=this._project;return t._view===this&&(t._view=null),H.remove(this._element,this._viewEvents),H.remove(n,this._windowEvents),this._element=this._project=null,this.off("frame"),this._animate=!1,this._frameItems={},!0},_events:r.each(w._itemHandlers.concat(["onResize","onKeyDown","onKeyUp"]),function(t){this[t]={}},{onFrame:{install:function(){this.play()},uninstall:function(){this.pause()}}}),_animate:!1,_time:0,_count:0,getAutoUpdate:function(){return this._autoUpdate},setAutoUpdate:function(t){this._autoUpdate=t,t&&this.requestUpdate()},update:function(){},draw:function(){this.update()},requestUpdate:function(){if(!this._requested){var t=this;H.requestAnimationFrame(function(){if(t._requested=!1,t._animate){t.requestUpdate();var e=t._element;U.getPrefixed(i,"hidden")&&"true"!==a.getAttribute(e,"keepalive")||!U.isInView(e)||t._handleFrame()}t._autoUpdate&&t.update()}),this._requested=!0}},play:function(){this._animate=!0,this.requestUpdate()},pause:function(){this._animate=!1},_handleFrame:function(){paper=this._scope;var t=Date.now()/1e3,e=this._last?t-this._last:0;this._last=t,this.emit("frame",new r({delta:e,time:this._time+=e,count:this._count++})),this._stats&&this._stats.update()},_animateItem:function(t,e){var n=this._frameItems;e?(n[t._id]={item:t,time:0,count:0},1===++this._frameItemCount&&this.on("frame",this._handleFrameItems)):(delete n[t._id],0===--this._frameItemCount&&this.off("frame",this._handleFrameItems))},_handleFrameItems:function(t){for(var e in this._frameItems){var n=this._frameItems[e];n.item.emit("frame",new r(t,{time:n.time+=t.delta,count:n.count++}))}},_changed:function(){this._project._changed(2049),this._bounds=this._decomposed=e},getElement:function(){return this._element},getPixelRatio:function(){return this._pixelRatio},getResolution:function(){return 72*this._pixelRatio},getViewSize:function(){var t=this._viewSize;return new _(t.width,t.height,this,"setViewSize")},setViewSize:function(){var t=d.read(arguments),e=t.subtract(this._viewSize);e.isZero()||(this._setElementSize(t.width,t.height),this._viewSize.set(t),this._changed(),this.emit("resize",{size:t,delta:e}),this._autoUpdate&&this.update())},_setElementSize:function(t,e){var n=this._element;n&&(n.width!==t&&(n.width=t),n.height!==e&&(n.height=e))},getBounds:function(){return this._bounds||(this._bounds=this._matrix.inverted()._transformBounds(new g(new c,this._viewSize))),this._bounds},getSize:function(){return this.getBounds().getSize()},isVisible:function(){return U.isInView(this._element)},isInserted:function(){return U.isInserted(this._element)},getPixelSize:function(t){var e,n=this._element;if(n){var r=n.parentNode,s=i.createElement("div");s.style.fontSize=t,r.appendChild(s),e=parseFloat(U.getStyles(s).fontSize),r.removeChild(s)}else e=parseFloat(e);return e},getTextWidth:function(t,e){return 0}},r.each(["rotate","scale","shear","skew"],function(t){var e="rotate"===t;this[t]=function(){var n=(e?r:c).read(arguments),i=c.read(arguments,0,{readNull:!0});return this.transform((new p)[t](n,i||this.getCenter(!0)))}},{_decompose:function(){return this._decomposed||(this._decomposed=this._matrix.decompose())},translate:function(){var t=new p;return this.transform(t.translate.apply(t,arguments))},getCenter:function(){return this.getBounds().getCenter()},setCenter:function(){var t=c.read(arguments);this.translate(this.getCenter().subtract(t))},getZoom:function(){var t=this._decompose(),e=t&&t.scaling;return e?(e.x+e.y)/2:0},setZoom:function(t){this.transform((new p).scale(t/this.getZoom(),this.getCenter()))},getRotation:function(){var t=this._decompose();return t&&t.rotation},setRotation:function(t){var e=this.getRotation();null!=e&&null!=t&&this.rotate(t-e)},getScaling:function(){var t=this._decompose(),n=t&&t.scaling;return n?new f(n.x,n.y,this,"setScaling"):e},setScaling:function(){var t=this.getScaling(),e=c.read(arguments,0,{clone:!0,readNull:!0});t&&e&&this.scale(e.x/t.x,e.y/t.y)},getMatrix:function(){return this._matrix},setMatrix:function(){var t=this._matrix;t.initialize.apply(t,arguments)},transform:function(t){this._matrix.append(t)},scrollBy:function(){this.translate(c.read(arguments).negate())}}),{projectToView:function(){return this._matrix._transformPoint(c.read(arguments))},viewToProject:function(){return this._matrix._inverseTransform(c.read(arguments))},getEventPoint:function(t){return this.viewToProject(H.getOffset(t,this._element))}},{statics:{_views:[],_viewsById:{},_id:0,create:function(t,e){i&&"string"==typeof e&&(e=i.getElementById(e));var r=n?W:Z;return new r(t,e)}}},new function(){function t(t){var e=H.getTarget(t);return e.getAttribute&&Z._viewsById[e.getAttribute("id")]}function e(){var t=Z._focused;if(!t||!t.isVisible())for(var e=0,n=Z._views.length;e<n;e++)if((t=Z._views[e]).isVisible()){Z._focused=h=t;break}}function r(t,e,n){t._handleMouseEvent("mousemove",e,n)}function s(t,e,n,i,r,s,a){function o(t,n){if(t.responds(n)){if(h||(h=new X(n,i,r,e||t,s?r.subtract(s):null)),t.emit(n,h)&&(I=!0,h.prevented&&(P=!0),h.stopped))return u=!0}else{var a=A[n];if(a)return o(t,a)}}for(var h,u=!1;t&&t!==a&&!o(t,n);)t=t._parent;return u}function a(t,e,n,i,r,a){return t._project.removeOn(n),P=I=!1,b&&s(b,null,n,i,r,a)||e&&e!==b&&!e.isDescendant(b)&&s(e,null,n,i,r,a,b)||s(t,b||e||t,n,i,r,a)}if(n){var o,h,u,l,c,f=!1,d=!1,_=n.navigator;_.pointerEnabled||_.msPointerEnabled?(u="pointerdown MSPointerDown",l="pointermove MSPointerMove",c="pointerup pointercancel MSPointerUp MSPointerCancel"):(u="touchstart",l="touchmove",c="touchend touchcancel","ontouchstart"in n&&_.userAgent.match(/mobile|tablet|ip(ad|hone|od)|android|silk/i)||(u+=" mousedown",l+=" mousemove",c+=" mouseup"));var g={},v={mouseout:function(t){var e=Z._focused,n=H.getRelatedTarget(t);if(e&&(!n||"HTML"===n.nodeName)){var i=H.getOffset(t,e._element),s=i.x,a=Math.abs,o=a(s),h=1<<25,u=o-h;i.x=a(u)<o?u*(s<0?-1:1):s,r(e,t,e.viewToProject(i))}},scroll:e};g[u]=function(e){var n=Z._focused=t(e);f||(f=!0,n._handleMouseEvent("mousedown",e))},v[l]=function(n){var i=Z._focused;if(!d){var s=t(n);s?i!==s&&(i&&r(i,n),o||(o=i),i=Z._focused=h=s):h&&h===i&&(o&&!o.isInserted()&&(o=null),i=Z._focused=o,o=null,e())}i&&r(i,n)},v[u]=function(){d=!0},v[c]=function(t){var e=Z._focused;e&&f&&e._handleMouseEvent("mouseup",t),d=f=!1},H.add(i,v),H.add(n,{load:e});var p,m,y,w,x,b,C,S,k,I=!1,P=!1,A={doubleclick:"click",mousedrag:"mousemove"},M=!1,T={mousedown:{mousedown:1,mousedrag:1,click:1,doubleclick:1},mouseup:{mouseup:1,mousedrag:1,click:1,doubleclick:1},mousemove:{mousedrag:1,mousemove:1,mouseenter:1,mouseleave:1}};return{_viewEvents:g,_handleMouseEvent:function(t,e,n){function i(t){return r.virtual[t]||l.responds(t)||u&&u.responds(t)}var r=this._itemEvents,o=r["native"][t],h="mousemove"===t,u=this._scope.tool,l=this;h&&f&&i("mousedrag")&&(t="mousedrag"),n||(n=this.getEventPoint(e));var c=this.getBounds().contains(n),d=o&&c&&l._project.hitTest(n,{tolerance:0,fill:!0,stroke:!0}),_=d&&d.item||null,g=!1,v={};if(v[t.substr(5)]=!0,o&&_!==x&&(x&&s(x,null,"mouseleave",e,n),_&&s(_,null,"mouseenter",e,n),x=_),M^c&&(s(this,null,c?"mouseenter":"mouseleave",e,n),p=c?this:null,g=!0),!c&&!v.drag||n.equals(y)||(a(this,_,h?t:"mousemove",e,n,y),g=!0),M=c,v.down&&c||v.up&&m){if(a(this,_,t,e,n,m),v.down){if(k=_===C&&Date.now()-S<300,w=C=_,!P&&_){for(var A=_;A&&!A.responds("mousedrag");)A=A._parent;A&&(b=_)}m=n}else v.up&&(P||_!==w||(S=Date.now(),a(this,_,k?"doubleclick":"click",e,n,m),k=!1),w=b=null);M=!1,g=!0}y=n,g&&u&&(I=u._handleMouseEvent(t,e,n,v)||I),(I&&!v.move||v.down&&i("mouseup"))&&e.preventDefault()},_handleKeyEvent:function(t,e,n,i){function r(r){r.responds(t)&&(paper=a,r.emit(t,s=s||new G(t,e,n,i)))}var s,a=this._scope,o=a.tool;this.isVisible()&&(r(this),o&&o.responds(t)&&r(o))},_countItemEvent:function(t,e){var n=this._itemEvents,i=n["native"],r=n.virtual;for(var s in T)i[s]=(i[s]||0)+(T[s][t]||0)*e;r[t]=(r[t]||0)+e},statics:{updateFocus:e}}}}),W=Z.extend({_class:"CanvasView",initialize:function(t,e){if(!(e instanceof n.HTMLCanvasElement)){var i=d.read(arguments,1);if(i.isZero())throw new Error("Cannot create CanvasView with the provided argument: "+r.slice(arguments,1));e=tt.getCanvas(i)}var s=this._context=e.getContext("2d");if(s.save(),this._pixelRatio=1,!/^off|false$/.test(a.getAttribute(e,"hidpi"))){var o=n.devicePixelRatio||1,h=U.getPrefixed(s,"backingStorePixelRatio")||1;this._pixelRatio=o/h}Z.call(this,t,e),this._needsUpdate=!0},remove:function St(){return this._context.restore(),St.base.call(this)},_setElementSize:function kt(t,e){var n=this._pixelRatio;if(kt.base.call(this,t*n,e*n),1!==n){var i=this._element,r=this._context;if(!a.hasAttribute(i,"resize")){var s=i.style;s.width=t+"px",s.height=e+"px"}r.restore(),r.save(),r.scale(n,n)}},getPixelSize:function It(t){var e,n=paper.agent;if(n&&n.firefox)e=It.base.call(this,t);else{var i=this._context,r=i.font;i.font=t+" serif",e=parseFloat(i.font),i.font=r}return e},getTextWidth:function(t,e){var n=this._context,i=n.font,r=0;n.font=t;for(var s=0,a=e.length;s<a;s++)r=Math.max(r,n.measureText(e[s]).width);return n.font=i,r},update:function(){if(!this._needsUpdate)return!1;var t=this._project,e=this._context,n=this._viewSize;return e.clearRect(0,0,n.width+1,n.height+1),t&&t.draw(e,this._matrix,this._pixelRatio),this._needsUpdate=!1,!0}}),$=r.extend({_class:"Event",initialize:function(t){this.event=t,this.type=t&&t.type},prevented:!1,stopped:!1,preventDefault:function(){this.prevented=!0,this.event.preventDefault()},stopPropagation:function(){this.stopped=!0,this.event.stopPropagation()},stop:function(){this.stopPropagation(),this.preventDefault()},getTimeStamp:function(){return this.event.timeStamp},getModifiers:function(){return J.modifiers}}),G=$.extend({_class:"KeyEvent",initialize:function(t,e,n,i){this.type=t,this.event=e,this.key=n,this.character=i},toString:function(){return"{ type: '"+this.type+"', key: '"+this.key+"', character: '"+this.character+"', modifiers: "+this.getModifiers()+" }"}}),J=new function(){function t(t){var e=t.key||t.keyIdentifier;return e=/^U\+/.test(e)?String.fromCharCode(parseInt(e.substr(2),16)):/^Arrow[A-Z]/.test(e)?e.substr(5):"Unidentified"===e?String.fromCharCode(t.keyCode):e,o[e]||(e.length>1?r.hyphenate(e):e.toLowerCase())}function e(t,n,i,a){var o,h=Z._focused;if(u[n]=t,t?l[n]=i:delete l[n],n.length>1&&(o=r.camelize(n))in c){c[o]=t;var f=paper&&paper.agent;if("meta"===o&&f&&f.mac)if(t)s={};else{for(var d in s)d in l&&e(!1,d,s[d],a);s=null}}else t&&s&&(s[n]=i);h&&h._handleKeyEvent(t?"keydown":"keyup",a,n,i)}var s,a,o={"\t":"tab"," ":"space","\b":"backspace","\x7f":"delete",Spacebar:"space",Del:"delete",Win:"meta",Esc:"escape"},h={tab:"\t",space:" ",enter:"\r"},u={},l={},c=new r({shift:!1,control:!1,alt:!1,meta:!1,capsLock:!1,space:!1}).inject({option:{get:function(){return this.alt}},command:{get:function(){var t=paper&&paper.agent;return t&&t.mac?this.meta:this.control}}});return H.add(i,{keydown:function(n){var i=t(n),r=paper&&paper.agent;i.length>1||r&&r.chrome&&(n.altKey||r.mac&&n.metaKey||!r.mac&&n.ctrlKey)?e(!0,i,h[i]||(i.length>1?"":i),n):a=i},keypress:function(n){if(a){var i=t(n),r=n.charCode,s=r>=32?String.fromCharCode(r):i.length>1?"":i;i!==a&&(i=s.toLowerCase()),e(!0,i,s,n),a=null}},keyup:function(n){var i=t(n);i in l&&e(!1,i,l[i],n)}}),H.add(n,{blur:function(t){for(var n in l)e(!1,n,l[n],t)}}),{modifiers:c,isDown:function(t){return!!u[t]}}},X=$.extend({_class:"MouseEvent",initialize:function(t,e,n,i,r){this.type=t,this.event=e,this.point=n,this.target=i,this.delta=r},toString:function(){return"{ type: '"+this.type+"', point: "+this.point+", target: "+this.target+(this.delta?", delta: "+this.delta:"")+", modifiers: "+this.getModifiers()+" }"}}),K=$.extend({_class:"ToolEvent",_item:null,initialize:function(t,e,n){this.tool=t,this.type=e,this.event=n},_choosePoint:function(t,e){return t?t:e?e.clone():null},getPoint:function(){return this._choosePoint(this._point,this.tool._point)},setPoint:function(t){this._point=t},getLastPoint:function(){return this._choosePoint(this._lastPoint,this.tool._lastPoint)},setLastPoint:function(t){this._lastPoint=t},getDownPoint:function(){return this._choosePoint(this._downPoint,this.tool._downPoint)},setDownPoint:function(t){this._downPoint=t},getMiddlePoint:function(){return!this._middlePoint&&this.tool._lastPoint?this.tool._point.add(this.tool._lastPoint).divide(2):this._middlePoint},setMiddlePoint:function(t){this._middlePoint=t},getDelta:function(){return!this._delta&&this.tool._lastPoint?this.tool._point.subtract(this.tool._lastPoint):this._delta},setDelta:function(t){this._delta=t},getCount:function(){return this.tool[/^mouse(down|up)$/.test(this.type)?"_downCount":"_moveCount"]},setCount:function(t){this.tool[/^mouse(down|up)$/.test(this.type)?"downCount":"count"]=t},getItem:function(){if(!this._item){var t=this.tool._scope.project.hitTest(this.getPoint());if(t){for(var e=t.item,n=e._parent;/^(Group|CompoundPath)$/.test(n._class);)e=n,n=n._parent;this._item=e}}return this._item},setItem:function(t){this._item=t},toString:function(){return"{ type: "+this.type+", point: "+this.getPoint()+", count: "+this.getCount()+", modifiers: "+this.getModifiers()+" }"}}),Y=o.extend({_class:"Tool",_list:"tools",_reference:"tool",_events:["onMouseDown","onMouseUp","onMouseDrag","onMouseMove","onActivate","onDeactivate","onEditOptions","onKeyDown","onKeyUp"],initialize:function(t){o.call(this),this._moveCount=-1,this._downCount=-1,this.set(t)},getMinDistance:function(){return this._minDistance},setMinDistance:function(t){this._minDistance=t,null!=t&&null!=this._maxDistance&&t>this._maxDistance&&(this._maxDistance=t)},getMaxDistance:function(){return this._maxDistance},setMaxDistance:function(t){this._maxDistance=t,null!=this._minDistance&&null!=t&&t<this._minDistance&&(this._minDistance=t)},getFixedDistance:function(){return this._minDistance==this._maxDistance?this._minDistance:null},setFixedDistance:function(t){this._minDistance=this._maxDistance=t},_handleMouseEvent:function(t,e,n,i){function r(t,e){var r=n,s=a?c._point:c._downPoint||r;if(a){if(c._moveCount&&r.equals(s))return!1;if(s&&(null!=t||null!=e)){var o=r.subtract(s),h=o.getLength();if(h<(t||0))return!1;e&&(r=s.add(o.normalize(Math.min(h,e))))}c._moveCount++}return c._point=r,c._lastPoint=s||r,i.down&&(c._moveCount=-1,c._downPoint=r,c._downCount++),!0}function s(){o&&(l=c.emit(t,new K(c,t,e))||l)}paper=this._scope,i.drag&&!this.responds(t)&&(t="mousemove");var a=i.move||i.drag,o=this.responds(t),h=this.minDistance,u=this.maxDistance,l=!1,c=this;if(i.down)r(),s();else if(i.up)r(null,u),s();else if(o)for(;r(h,u);)s();return l}}),Q={request:function(e){var n=new t.XMLHttpRequest;return n.open((e.method||"get").toUpperCase(),e.url,r.pick(e.async,!0)),e.mimeType&&n.overrideMimeType(e.mimeType),n.onload=function(){var t=n.status;0===t||200===t?e.onLoad&&e.onLoad.call(n,n.responseText):n.onerror()},n.onerror=function(){var t=n.status,i='Could not load "'+e.url+'" (Status: '+t+")";if(!e.onError)throw new Error(i);e.onError(i,t)},n.send(null)}},tt={canvases:[],getCanvas:function(t,e){if(!n)return null;var r,s=!0;"object"==typeof t&&(e=t.height,t=t.width),this.canvases.length?r=this.canvases.pop():(r=i.createElement("canvas"),s=!1);var a=r.getContext("2d");if(!a)throw new Error("Canvas "+r+" is unable to provide a 2D context.");return r.width===t&&r.height===e?s&&a.clearRect(0,0,t+1,e+1):(r.width=t,r.height=e),a.save(),r},getContext:function(t,e){var n=this.getCanvas(t,e);return n?n.getContext("2d"):null},release:function(t){var e=t&&t.canvas?t.canvas:t;e&&e.getContext&&(e.getContext("2d").restore(),this.canvases.push(e))}},et=new function(){function t(t,e,n){return.2989*t+.587*e+.114*n}function e(e,n,i,r){var s=r-t(e,n,i);d=e+s,_=n+s,g=i+s;var r=t(d,_,g),a=v(d,_,g),o=p(d,_,g);if(a<0){var h=r-a;d=r+(d-r)*r/h,_=r+(_-r)*r/h,g=r+(g-r)*r/h}if(o>255){var u=255-r,l=o-r;d=r+(d-r)*u/l,_=r+(_-r)*u/l,g=r+(g-r)*u/l}}function n(t,e,n){return p(t,e,n)-v(t,e,n)}function i(t,e,n,i){var r,s=[t,e,n],a=p(t,e,n),o=v(t,e,n);o=o===t?0:o===e?1:2,a=a===t?0:a===e?1:2,r=0===v(o,a)?1===p(o,a)?2:1:0,s[a]>s[o]?(s[r]=(s[r]-s[o])*i/(s[a]-s[o]),s[a]=i):s[r]=s[a]=0,s[o]=0,d=s[0],_=s[1],g=s[2]}var s,a,o,h,u,l,c,f,d,_,g,v=Math.min,p=Math.max,m=Math.abs,y={multiply:function(){d=u*s/255,_=l*a/255,g=c*o/255},screen:function(){d=u+s-u*s/255,_=l+a-l*a/255,g=c+o-c*o/255},overlay:function(){d=u<128?2*u*s/255:255-2*(255-u)*(255-s)/255,_=l<128?2*l*a/255:255-2*(255-l)*(255-a)/255,g=c<128?2*c*o/255:255-2*(255-c)*(255-o)/255},"soft-light":function(){var t=s*u/255;d=t+u*(255-(255-u)*(255-s)/255-t)/255,t=a*l/255,_=t+l*(255-(255-l)*(255-a)/255-t)/255,t=o*c/255,g=t+c*(255-(255-c)*(255-o)/255-t)/255},"hard-light":function(){d=s<128?2*s*u/255:255-2*(255-s)*(255-u)/255,_=a<128?2*a*l/255:255-2*(255-a)*(255-l)/255,g=o<128?2*o*c/255:255-2*(255-o)*(255-c)/255},"color-dodge":function(){d=0===u?0:255===s?255:v(255,255*u/(255-s)),_=0===l?0:255===a?255:v(255,255*l/(255-a)),g=0===c?0:255===o?255:v(255,255*c/(255-o))},"color-burn":function(){d=255===u?255:0===s?0:p(0,255-255*(255-u)/s),_=255===l?255:0===a?0:p(0,255-255*(255-l)/a),g=255===c?255:0===o?0:p(0,255-255*(255-c)/o)},darken:function(){d=u<s?u:s,_=l<a?l:a,g=c<o?c:o},lighten:function(){d=u>s?u:s,_=l>a?l:a,g=c>o?c:o},difference:function(){d=u-s,d<0&&(d=-d),_=l-a,_<0&&(_=-_),g=c-o,g<0&&(g=-g)},exclusion:function(){d=u+s*(255-u-u)/255,_=l+a*(255-l-l)/255,g=c+o*(255-c-c)/255},hue:function(){i(s,a,o,n(u,l,c)),e(d,_,g,t(u,l,c))},saturation:function(){i(u,l,c,n(s,a,o)),e(d,_,g,t(u,l,c))},luminosity:function(){e(u,l,c,t(s,a,o))},color:function(){e(s,a,o,t(u,l,c))},add:function(){d=v(u+s,255),_=v(l+a,255),g=v(c+o,255)},subtract:function(){d=p(u-s,0),_=p(l-a,0),g=p(c-o,0)},average:function(){d=(u+s)/2,_=(l+a)/2,g=(c+o)/2},negation:function(){d=255-m(255-s-u),_=255-m(255-a-l),g=255-m(255-o-c)}},w=this.nativeModes=r.each(["source-over","source-in","source-out","source-atop","destination-over","destination-in","destination-out","destination-atop","lighter","darker","copy","xor"],function(t){this[t]=!0},{}),x=tt.getContext(1,1);x&&(r.each(y,function(t,e){var n="darken"===e,i=!1;x.save();try{x.fillStyle=n?"#300":"#a00",x.fillRect(0,0,1,1),x.globalCompositeOperation=e,x.globalCompositeOperation===e&&(x.fillStyle=n?"#a00":"#300",x.fillRect(0,0,1,1),i=x.getImageData(0,0,1,1).data[0]!==n?170:51)}catch(r){}x.restore(),w[e]=i}),tt.release(x)),this.process=function(t,e,n,i,r){var v=e.canvas,p="normal"===t;if(p||w[t])n.save(),n.setTransform(1,0,0,1,0,0),n.globalAlpha=i,p||(n.globalCompositeOperation=t),n.drawImage(v,r.x,r.y),n.restore();else{var m=y[t];if(!m)return;for(var x=n.getImageData(r.x,r.y,v.width,v.height),b=x.data,C=e.getImageData(0,0,v.width,v.height).data,S=0,k=b.length;S<k;S+=4){s=C[S],u=b[S],a=C[S+1],l=b[S+1],o=C[S+2],c=b[S+2],h=C[S+3],f=b[S+3],m();var I=h*i/255,P=1-I;b[S]=I*d+P*u,b[S+1]=I*_+P*l,b[S+2]=I*g+P*c,b[S+3]=h*i+P*f}n.putImageData(x,r.x,r.y)}}},nt=new function(){function t(t,e,s){return n(i.createElementNS(r,t),e,s)}function e(t,e){var n=o[e],i=n?t.getAttributeNS(n,e):t.getAttribute(e);return"null"===i?null:i}function n(t,e,n){for(var i in e){var r=e[i],s=o[i];"number"==typeof r&&n&&(r=n.number(r)),s?t.setAttributeNS(s,i,r):t.setAttribute(i,r)}return t}var r="http://www.w3.org/2000/svg",s="http://www.w3.org/2000/xmlns",a="http://www.w3.org/1999/xlink",o={href:a,xlink:s,xmlns:s+"/","xmlns:xlink":s+"/"};return{svg:r,xmlns:s,xlink:a,create:t,get:e,set:n}},it=r.each({fillColor:["fill","color"],fillRule:["fill-rule","string"],strokeColor:["stroke","color"],strokeWidth:["stroke-width","number"],strokeCap:["stroke-linecap","string"],strokeJoin:["stroke-linejoin","string"],strokeScaling:["vector-effect","lookup",{"true":"none","false":"non-scaling-stroke"},function(t,e){return!e&&(t instanceof O||t instanceof C||t instanceof j)}],miterLimit:["stroke-miterlimit","number"],dashArray:["stroke-dasharray","array"],dashOffset:["stroke-dashoffset","number"],fontFamily:["font-family","string"],fontWeight:["font-weight","string"],fontSize:["font-size","number"],justification:["text-anchor","lookup",{left:"start",center:"middle",right:"end"}],opacity:["opacity","number"],blendMode:["mix-blend-mode","style"]},function(t,e){var n=r.capitalize(e),i=t[2];this[e]={type:t[1],property:e,attribute:t[0],toSVG:i,fromSVG:i&&r.each(i,function(t,e){this[t]=e},{}),exportFilter:t[3],get:"get"+n,set:"set"+n}},{});return new function(){function e(t,e,n){var i=new r,s=t.getTranslation();if(e){t=t._shiftless();var a=t._inverseTransform(s);i[n?"cx":"x"]=a.x,i[n?"cy":"y"]=a.y,s=null}if(!t.isIdentity()){var o=t.decompose();if(o){var h=[],l=o.rotation,c=o.scaling,f=o.skewing;s&&!s.isZero()&&h.push("translate("+S.point(s)+")"),l&&h.push("rotate("+S.number(l)+")"),u.isZero(c.x-1)&&u.isZero(c.y-1)||h.push("scale("+S.point(c)+")"),f.x&&h.push("skewX("+S.number(f.x)+")"),f.y&&h.push("skewY("+S.number(f.y)+")"),i.transform=h.join(" ")}else i.transform="matrix("+t.getValues().join(",")+")"}return i}function n(t,n){for(var i=e(t._matrix),r=t._children,s=nt.create("g",i,S),a=0,o=r.length;a<o;a++){var h=r[a],u=b(h,n);if(u)if(h.isClipMask()){var l=nt.create("clipPath");l.appendChild(u),m(h,l,"clip"),nt.set(s,{"clip-path":"url(#"+l.id+")"})}else s.appendChild(u)}return s}function i(t,n){var i=e(t._matrix,!0),r=t.getSize(),s=t.getImage();return i.x-=r.width/2,i.y-=r.height/2,i.width=r.width,i.height=r.height,i.href=0==n.embedImages&&s&&s.src||t.toDataURL(),nt.create("image",i,S)}function s(t,n){var i=n.matchShapes;if(i){var r=t.toShape(!1);if(r)return a(r,n)}var s,o=t._segments,h=o.length,u=e(t._matrix);if(i&&h>=2&&!t.hasHandles())if(h>2){s=t._closed?"polygon":"polyline";for(var l=[],c=0;c<h;c++)l.push(S.point(o[c]._point));u.points=l.join(" ")}else{s="line";var f=o[0]._point,d=o[1]._point;u.set({x1:f.x,y1:f.y,x2:d.x,y2:d.y})}else s="path",u.d=t.getPathData(null,n.precision);return nt.create(s,u,S)}function a(t){var n=t._type,i=t._radius,r=e(t._matrix,!0,"rectangle"!==n);if("rectangle"===n){n="rect";var s=t._size,a=s.width,o=s.height;r.x-=a/2,r.y-=o/2,r.width=a,r.height=o,i.isZero()&&(i=null)}return i&&("circle"===n?r.r=i:(r.rx=i.width,r.ry=i.height)),nt.create(n,r,S)}function o(t,n){var i=e(t._matrix),r=t.getPathData(null,n.precision);return r&&(i.d=r),nt.create("path",i,S)}function c(t,n){var i=e(t._matrix,!0),r=t._definition,s=v(r,"symbol"),a=r._item,o=a.getBounds();return s||(s=nt.create("symbol",{viewBox:S.rectangle(o)}),s.appendChild(b(a,n)),m(r,s,"symbol")),i.href="#"+s.id,i.x+=o.x,i.y+=o.y,i.width=o.width,i.height=o.height,i.overflow="visible",nt.create("use",i,S)}function f(t){var e=v(t,"color");if(!e){var n,i=t.getGradient(),r=i._radial,s=t.getOrigin(),a=t.getDestination();if(r){n={cx:s.x,cy:s.y,r:s.getDistance(a)};var o=t.getHighlight();o&&(n.fx=o.x,n.fy=o.y)}else n={x1:s.x,y1:s.y,x2:a.x,y2:a.y};n.gradientUnits="userSpaceOnUse",e=nt.create((r?"radial":"linear")+"Gradient",n,S);for(var h=i._stops,u=0,l=h.length;u<l;u++){var c=h[u],f=c._color,d=f.getAlpha(),_=c._offset;n={offset:null==_?u/(l-1):_},f&&(n["stop-color"]=f.toCSS(!0)),d<1&&(n["stop-opacity"]=d),e.appendChild(nt.create("stop",n,S))}m(t,e,"color")}return"url(#"+e.id+")"}function d(t){var n=nt.create("text",e(t._matrix,!0),S);return n.textContent=t._content,n}function _(t,e,n){var i={},s=!n&&t.getParent(),a=[];return null!=t._name&&(i.id=t._name),r.each(it,function(e){var n=e.get,o=e.type,h=t[n]();if(e.exportFilter?e.exportFilter(t,h):!s||!r.equals(s[n](),h)){if("color"===o&&null!=h){var u=h.getAlpha();u<1&&(i[e.attribute+"-opacity"]=u)}"style"===o?a.push(e.attribute+": "+h):i[e.attribute]=null==h?"none":"color"===o?h.gradient?f(h,t):h.toCSS(!0):"array"===o?h.join(","):"lookup"===o?e.toSVG[h]:h}}),a.length&&(i.style=a.join(";")),1===i.opacity&&delete i.opacity,t._visible||(i.visibility="hidden"),nt.set(e,i,S)}function v(t,e){return k||(k={ids:{},svgs:{}}),t&&k.svgs[e+"-"+(t._id||t.__id||(t.__id=l.get("svg")))]}function m(t,e,n){k||v();var i=k.ids[n]=(k.ids[n]||0)+1;e.id=n+"-"+i,k.svgs[n+"-"+(t._id||t.__id)]=e}function x(e,n){var i=e,r=null;if(k){i="svg"===e.nodeName.toLowerCase()&&e;for(var s in k.svgs)r||(i||(i=nt.create("svg"),i.appendChild(e)),
r=i.insertBefore(nt.create("defs"),i.firstChild)),r.appendChild(k.svgs[s]);k=null}return n.asString?(new t.XMLSerializer).serializeToString(i):i}function b(t,e,n){var i=I[t._class],r=i&&i(t,e);if(r){var s=e.onExport;s&&(r=s(t,r,e)||r);var a=JSON.stringify(t._data);a&&"{}"!==a&&"null"!==a&&r.setAttribute("data-paper-data",a)}return r&&_(t,r,n)}function C(t){return t||(t={}),S=new h(t.precision),t}var S,k,I={Group:n,Layer:n,Raster:i,Path:s,Shape:a,CompoundPath:o,SymbolItem:c,PointText:d};w.inject({exportSVG:function(t){return t=C(t),x(b(this,t,!0),t)}}),y.inject({exportSVG:function(t){t=C(t);var n=this._children,i=this.getView(),s=r.pick(t.bounds,"view"),a=t.matrix||"view"===s&&i._matrix,o=a&&p.read([a]),h="view"===s?new g([0,0],i.getViewSize()):"content"===s?w._getBounds(n,o,{stroke:!0}).rect:g.read([s],0,{readNull:!0}),u={version:"1.1",xmlns:nt.svg,"xmlns:xlink":nt.xlink};h&&(u.width=h.width,u.height=h.height,(h.x||h.y)&&(u.viewBox=S.rectangle(h)));var l=nt.create("svg",u,S),c=l;o&&!o.isIdentity()&&(c=l.appendChild(nt.create("g",e(o),S)));for(var f=0,d=n.length;f<d;f++)c.appendChild(b(n[f],t,!0));return x(l,t)}})},new function(){function s(t,e,n,i,r){var s=nt.get(t,e),a=null==s?i?null:n?"":0:n?s:parseFloat(s);return/%\s*$/.test(s)?a/100*(r?1:T[/x|^width/.test(e)?"width":"height"]):a}function a(t,e,n,i,r){return e=s(t,e||"x",!1,i,r),n=s(t,n||"y",!1,i,r),!i||null!=e&&null!=n?new c(e,n):null}function o(t,e,n,i,r){return e=s(t,e||"width",!1,i,r),n=s(t,n||"height",!1,i,r),!i||null!=e&&null!=n?new d(e,n):null}function h(t,e,n){return"none"===t?null:"number"===e?parseFloat(t):"array"===e?t?t.split(/[\s,]+/g).map(parseFloat):[]:"color"===e?P(t)||t:"lookup"===e?n[t]:t}function u(t,e,n,i){var r=t.childNodes,s="clippath"===e,a="defs"===e,o=new x,h=o._project,u=h._currentStyle,l=[];if(s||a||(o=k(o,t,i),h._currentStyle=o._style.clone()),i)for(var c=t.querySelectorAll("defs"),f=0,d=c.length;f<d;f++)A(c[f],n,!1);for(var f=0,d=r.length;f<d;f++){var _,g=r[f];1!==g.nodeType||/^defs$/i.test(g.nodeName)||!(_=A(g,n,!1))||_ instanceof I||l.push(_)}return o.addChildren(l),s&&(o=k(o.reduce(),t,i)),h._currentStyle=u,(s||a)&&(o.remove(),o=null),o}function l(t,e){for(var n=t.getAttribute("points").match(/[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g),i=[],r=0,s=n.length;r<s;r+=2)i.push(new c(parseFloat(n[r]),parseFloat(n[r+1])));var a=new L(i);return"polygon"===e&&a.closePath(),a}function f(t){return O.create(t.getAttribute("d"))}function _(t,e){var n,i=(s(t,"href",!0)||"").substring(1),r="radialgradient"===e;if(i)n=z[i].getGradient(),n._radial^r&&(n=n.clone(),n._radial=r);else{for(var o=t.childNodes,h=[],u=0,l=o.length;u<l;u++){var c=o[u];1===c.nodeType&&h.push(k(new q,c))}n=new R(h,r)}var f,d,_,g="userSpaceOnUse"!==s(t,"gradientUnits",!0);r?(f=a(t,"cx","cy",!1,g),d=f.add(s(t,"r",!1,!1,g),0),_=a(t,"fx","fy",!0,g)):(f=a(t,"x1","y1",!1,g),d=a(t,"x2","y2",!1,g));var v=k(new D(n,f,d,_),t);return v._scaleToBounds=g,null}function v(t,e,n,i){if(t.transform){for(var r=(i.getAttribute(n)||"").split(/\)\s*/g),s=new p,a=0,o=r.length;a<o;a++){var h=r[a];if(!h)break;for(var u=h.split(/\(\s*/),l=u[0],c=u[1].split(/[\s,]+/g),f=0,d=c.length;f<d;f++)c[f]=parseFloat(c[f]);switch(l){case"matrix":s.append(new p(c[0],c[1],c[2],c[3],c[4],c[5]));break;case"rotate":s.rotate(c[0],c[1],c[2]);break;case"translate":s.translate(c[0],c[1]);break;case"scale":s.scale(c);break;case"skewX":s.skew(c[0],0);break;case"skewY":s.skew(0,c[0])}}t.transform(s)}}function m(t,e,n){var i="fill-opacity"===n?"getFillColor":"getStrokeColor",r=t[i]&&t[i]();r&&r.setAlpha(parseFloat(e))}function b(t,n,i){var s=t.attributes[n],a=s&&s.value;if(!a){var o=r.camelize(n);a=t.style[o],a||i.node[o]===i.parent[o]||(a=i.node[o])}return a?"none"===a?null:a:e}function k(t,n,i){if(n.style){var s=n.parentNode,a={node:U.getStyles(n)||{},parent:!i&&!/^defs$/i.test(s.tagName)&&U.getStyles(s)||{}};r.each(N,function(i,r){var s=b(n,r,a);t=s!==e&&i(t,s,r,n,a)||t})}return t}function P(t){var e=t&&t.match(/\((?:["'#]*)([^"')]+)/),i=e&&e[1],r=i&&z[n?i.replace(n.location.href.split("#")[0]+"#",""):i];return r&&r._scaleToBounds&&(r=r.clone(),r._scaleToBounds=!0),r}function A(t,e,n){var s,a,h,u=t.nodeName.toLowerCase(),l="#document"!==u,c=i.body;n&&l&&(T=paper.getView().getSize(),T=o(t,null,null,!0)||T,s=nt.create("svg",{style:"stroke-width: 1px; stroke-miterlimit: 10"}),a=t.parentNode,h=t.nextSibling,s.appendChild(t),c.appendChild(s));var f=paper.settings,d=f.applyMatrix,_=f.insertItems;f.applyMatrix=!1,f.insertItems=!1;var g=E[u],v=g&&g(t,u,e,n)||null;if(f.insertItems=_,f.applyMatrix=d,v){!l||v instanceof x||(v=k(v,t,n));var p=e.onImport,m=l&&t.getAttribute("data-paper-data");p&&(v=p(t,v,e)||v),e.expandShapes&&v instanceof C&&(v.remove(),v=v.toPath()),m&&(v._data=JSON.parse(m))}return s&&(c.removeChild(s),a&&(h?a.insertBefore(t,h):a.appendChild(t))),n&&(z={},v&&r.pick(e.applyMatrix,d)&&v.matrix.apply(!0,!0)),v}function M(n,r,s){function a(i){try{var a="object"==typeof i?i:(new t.DOMParser).parseFromString(i,"image/svg+xml");if(!a.nodeName)throw a=null,new Error("Unsupported SVG source: "+n);paper=h,u=A(a,r,!0),r&&r.insert===!1||s._insertItem(e,u);var l=r.onLoad;l&&l(u,i)}catch(c){o(c)}}function o(t,e){var n=r.onError;if(!n)throw new Error(t);n(t,e)}if(!n)return null;r="function"==typeof r?{onLoad:r}:r||{};var h=paper,u=null;if("string"!=typeof n||/^.*</.test(n)){if("undefined"!=typeof File&&n instanceof File){var l=new FileReader;return l.onload=function(){a(l.result)},l.onerror=function(){o(l.error)},l.readAsText(n)}a(n)}else{var c=i.getElementById(n);c?a(c):Q.request({url:n,async:!0,onLoad:a,onError:o})}return u}var T,z={},E={"#document":function(t,e,n,i){for(var r=t.childNodes,s=0,a=r.length;s<a;s++){var o=r[s];if(1===o.nodeType)return A(o,n,i)}},g:u,svg:u,clippath:u,polygon:l,polyline:l,path:f,lineargradient:_,radialgradient:_,image:function(t){var e=new S(s(t,"href",!0));return e.on("load",function(){var e=o(t);this.setSize(e);var n=this._matrix._transformPoint(a(t).add(e.divide(2)));this.translate(n)}),e},symbol:function(t,e,n,i){return new I(u(t,e,n,i),(!0))},defs:u,use:function(t){var e=(s(t,"href",!0)||"").substring(1),n=z[e],i=a(t);return n?n instanceof I?n.place(i):n.clone().translate(i):null},circle:function(t){return new C.Circle(a(t,"cx","cy"),s(t,"r"))},ellipse:function(t){return new C.Ellipse({center:a(t,"cx","cy"),radius:o(t,"rx","ry")})},rect:function(t){return new C.Rectangle(new g(a(t),o(t)),o(t,"rx","ry"))},line:function(t){return new L.Line(a(t,"x1","y1"),a(t,"x2","y2"))},text:function(t){var e=new F(a(t).add(a(t,"dx","dy")));return e.setContent(t.textContent.trim()||""),e}},N=r.set(r.each(it,function(t){this[t.attribute]=function(e,n){if(e[t.set]&&(e[t.set](h(n,t.type,t.fromSVG)),"color"===t.type)){var i=e[t.get]();if(i&&i._scaleToBounds){var r=e.getBounds();i.transform((new p).translate(r.getPoint()).scale(r.getSize()))}}}},{}),{id:function(t,e){z[e]=t,t.setName&&t.setName(e)},"clip-path":function(t,e){var n=P(e);if(n){if(n=n.clone(),n.setClipMask(!0),!(t instanceof x))return new x(n,t);t.insertChild(0,n)}},gradientTransform:v,transform:v,"fill-opacity":m,"stroke-opacity":m,visibility:function(t,e){t.setVisible&&t.setVisible("visible"===e)},display:function(t,e){t.setVisible&&t.setVisible(null!==e)},"stop-color":function(t,e){t.setColor&&t.setColor(e)},"stop-opacity":function(t,e){t._color&&t._color.setAlpha(parseFloat(e))},offset:function(t,e){if(t.setOffset){var n=e.match(/(.*)%$/);t.setOffset(n?n[1]/100:parseFloat(e))}},viewBox:function(t,e,n,i,r){var s,a,u=new g(h(e,"array")),l=o(i,null,null,!0);if(t instanceof x){var c=l?l.divide(u.getSize()):1,a=(new p).scale(c).translate(u.getPoint().negate());s=t}else t instanceof I&&(l&&u.setSize(l),s=t._item);if(s){if("visible"!==b(i,"overflow",r)){var f=new C.Rectangle(u);f.setClipMask(!0),s.addChild(f)}a&&s.transform(a)}}});w.inject({importSVG:function(t,e){return M(t,e,this)}}),y.inject({importSVG:function(t,e){return this.activate(),M(t,e,this)}})},r.exports.PaperScript=function(){function e(t,e){return(g.acorn||v).parse(t,e)}function s(t,e,n){var i=w[e];if(t&&t[i]){var r=t[i](n);return"!="===e?!r:r}switch(e){case"+":return t+n;case"-":return t-n;case"*":return t*n;case"/":return t/n;case"%":return t%n;case"==":return t==n;case"!=":return t!=n}}function o(t,e){var n=x[t];if(e&&e[n])return e[n]();switch(t){case"+":return+e;case"-":return-e}}function h(r,s){function a(t){for(var e=0,n=d.length;e<n;e++){var i=d[e];if(i[0]>=t)break;t+=i[1]}return t}function o(t){return r.substring(a(t.range[0]),a(t.range[1]))}function h(t,e){return r.substring(a(t.range[1]),a(e.range[0]))}function u(t,e){for(var n=a(t.range[0]),i=a(t.range[1]),s=0,o=d.length-1;o>=0;o--)if(n>d[o][0]){s=o+1;break}d.splice(s,0,[n,e.length-i+n]),r=r.substring(0,n)+e+r.substring(i)}function l(t,e){if(t){for(var n in t)if("range"!==n&&"loc"!==n){var i=t[n];if(Array.isArray(i))for(var r=0,s=i.length;r<s;r++)l(i[r],t);else i&&"object"==typeof i&&l(i,t)}switch(t.type){case"UnaryExpression":if(t.operator in x&&"Literal"!==t.argument.type){var a=o(t.argument);u(t,'$__("'+t.operator+'", '+a+")")}break;case"BinaryExpression":if(t.operator in w&&"Literal"!==t.left.type){var c=o(t.left),f=o(t.right),d=h(t.left,t.right),_=t.operator;u(t,"__$__("+c+","+d.replace(new RegExp("\\"+_),'"'+_+'"')+", "+f+")")}break;case"UpdateExpression":case"AssignmentExpression":var g=e&&e.type;if(!("ForStatement"===g||"BinaryExpression"===g&&/^[=!<>]/.test(e.operator)||"MemberExpression"===g&&e.computed))if("UpdateExpression"===t.type){var a=o(t.argument),v="__$__("+a+', "'+t.operator[0]+'", 1)',p=a+" = "+v;t.prefix||"AssignmentExpression"!==g&&"VariableDeclarator"!==g||(o(e.left||e.id)===a&&(p=v),p=a+"; "+p),u(t,p)}else if(/^.=$/.test(t.operator)&&"Literal"!==t.left.type){var c=o(t.left),f=o(t.right),v=c+" = __$__("+c+', "'+t.operator[0]+'", '+f+")";u(t,/^\(.*\)$/.test(o(t))?"("+v+")":v)}}}}function c(t){var e="",n="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";for(t=(Math.abs(t)<<1)+(t<0?1:0);t||!e;){var i=31&t;t>>=5,t&&(i|=32),e+=n[i]}return e}if(!r)return"";s=s||{};var f,d=[],_=s.url||"",g=paper.agent,v=g.versionNumber,p=!1,m=s.sourceMaps,y=s.source||r,b=/\r\n|\n|\r/gm,C=s.offset||0;if(m&&(g.chrome&&v>=30||g.webkit&&v>=537.76||g.firefox&&v>=23||g.node)){if(g.node)C-=2;else if(n&&_&&!n.location.href.indexOf(_)){var S=i.getElementsByTagName("html")[0].innerHTML;C=S.substr(0,S.indexOf(r)+1).match(b).length+1}p=C>0&&!(g.chrome&&v>=36||g.safari&&v>=600||g.firefox&&v>=40||g.node);var k=["AA"+c(p?0:C)+"A"];k.length=(r.match(b)||[]).length+1+(p?C:0),f={version:3,file:_,names:[],mappings:k.join(";AACA"),sourceRoot:"",sources:[_],sourcesContent:[y]}}return l(e(r,{ranges:!0,preserveParens:!0})),f&&(p&&(r=new Array(C+1).join("\n")+r),/^(inline|both)$/.test(m)&&(r+="\n//# sourceMappingURL=data:application/json;base64,"+t.btoa(unescape(encodeURIComponent(JSON.stringify(f))))),r+="\n//# sourceURL="+(_||"paperscript")),{url:_,source:y,code:r,map:f}}function u(t,e,n){function a(e,n){for(var i in e)!n&&/^_/.test(i)||!new RegExp("([\\b\\s\\W]|^)"+i.replace(/\$/g,"\\$")+"\\b").test(t)||(g.push(i),v.push(e[i]))}paper=e;var u,l=e.getView(),f=/\btool\.\w+|\s+on(?:Key|Mouse)(?:Up|Down|Move|Drag)\b/.test(t)&&!/\bnew\s+Tool\b/.test(t)?new Y:null,d=f?f._events:[],_=["onFrame","onResize"].concat(d),g=[],v=[],p="object"==typeof t?t:h(t,n);t=p.code,a({__$__:s,$__:o,paper:e,view:l,tool:f},!0),a(e),_=r.each(_,function(e){new RegExp("\\s+"+e+"\\b").test(t)&&(g.push(e),this.push(e+": "+e))},[]).join(", "),_&&(t+="\nreturn { "+_+" };");var m=paper.agent;if(i&&(m.chrome||m.firefox&&m.versionNumber<40)){var y=i.createElement("script"),w=i.head||i.getElementsByTagName("head")[0];m.firefox&&(t="\n"+t),y.appendChild(i.createTextNode("paper._execute = function("+g+") {"+t+"\n}")),w.appendChild(y),u=paper._execute,delete paper._execute,w.removeChild(y)}else u=Function(g,t);var x=u.apply(e,v)||{};return r.each(d,function(t){var e=x[t];e&&(f[t]=e)}),l&&(x.onResize&&l.setOnResize(x.onResize),l.emit("resize",{size:l.size,delta:new c}),x.onFrame&&l.setOnFrame(x.onFrame),l.requestUpdate()),p}function l(t){if(/^text\/(?:x-|)paperscript$/.test(t.type)&&"true"!==a.getAttribute(t,"ignore")){var e=a.getAttribute(t,"canvas"),n=i.getElementById(e),r=t.src||t.getAttribute("data-src"),s=a.hasAttribute(t,"async"),o="data-paper-scope";if(!n)throw new Error('Unable to find canvas with id "'+e+'"');var h=a.get(n.getAttribute(o))||(new a).setup(n);return n.setAttribute(o,h._id),r?Q.request({url:r,async:s,mimeType:"text/plain",onLoad:function(t){u(t,h,r)}}):u(t.innerHTML,h,t.baseURI),t.setAttribute("data-paper-ignore","true"),h}}function f(){r.each(i&&i.getElementsByTagName("script"),l)}function _(t){return t?l(t):f()}var g=this,v=g.acorn;if(!v&&"undefined"!=typeof require)try{v=require("acorn")}catch(p){}if(!v){var m,y;v=m=y={},function(t,e){return"object"==typeof m&&"object"==typeof y?e(m):"function"==typeof define&&define.amd?define(["exports"],e):void e(t.acorn||(t.acorn={}))}(this,function(t){"use strict";function e(t){ct=t||{};for(var e in gt)Object.prototype.hasOwnProperty.call(ct,e)||(ct[e]=gt[e]);_t=ct.sourceFile||null}function n(t,e){var n=vt(ft,t);e+=" ("+n.line+":"+n.column+")";var i=new SyntaxError(e);throw i.pos=t,i.loc=n,i.raisedAt=pt,i}function i(t){function e(t){if(1==t.length)return n+="return str === "+JSON.stringify(t[0])+";";n+="switch(str){";for(var e=0;e<t.length;++e)n+="case "+JSON.stringify(t[e])+":";n+="return true}return false;"}t=t.split(" ");var n="",i=[];t:for(var r=0;r<t.length;++r){for(var s=0;s<i.length;++s)if(i[s][0].length==t[r].length){i[s].push(t[r]);continue t}i.push([t[r]])}if(i.length>3){i.sort(function(t,e){return e.length-t.length}),n+="switch(str.length){";for(var r=0;r<i.length;++r){var a=i[r];n+="case "+a[0].length+":",e(a)}n+="}"}else e(t);return new Function("str",n)}function r(){this.line=kt,this.column=pt-It}function s(){kt=1,pt=It=0,St=!0,u()}function a(t,e){yt=pt,ct.locations&&(xt=new r),bt=t,u(),Ct=e,St=t.beforeExpr}function o(){var t=ct.onComment&&ct.locations&&new r,e=pt,i=ft.indexOf("*/",pt+=2);if(i===-1&&n(pt-2,"Unterminated comment"),pt=i+2,ct.locations){Xe.lastIndex=e;for(var s;(s=Xe.exec(ft))&&s.index<pt;)++kt,It=s.index+s[0].length}ct.onComment&&ct.onComment(!0,ft.slice(e+2,i),e,pt,t,ct.locations&&new r)}function h(){for(var t=pt,e=ct.onComment&&ct.locations&&new r,n=ft.charCodeAt(pt+=2);pt<dt&&10!==n&&13!==n&&8232!==n&&8233!==n;)++pt,n=ft.charCodeAt(pt);ct.onComment&&ct.onComment(!1,ft.slice(t+2,pt),t,pt,e,ct.locations&&new r)}function u(){for(;pt<dt;){var t=ft.charCodeAt(pt);if(32===t)++pt;else if(13===t){++pt;var e=ft.charCodeAt(pt);10===e&&++pt,ct.locations&&(++kt,It=pt)}else if(10===t||8232===t||8233===t)++pt,ct.locations&&(++kt,It=pt);else if(t>8&&t<14)++pt;else if(47===t){var e=ft.charCodeAt(pt+1);if(42===e)o();else{if(47!==e)break;h()}}else if(160===t)++pt;else{if(!(t>=5760&&He.test(String.fromCharCode(t))))break;++pt}}}function l(){var t=ft.charCodeAt(pt+1);return t>=48&&t<=57?S(!0):(++pt,a(we))}function c(){var t=ft.charCodeAt(pt+1);return St?(++pt,x()):61===t?w(Se,2):w(be,1)}function f(){var t=ft.charCodeAt(pt+1);return 61===t?w(Se,2):w(Be,1)}function d(t){var e=ft.charCodeAt(pt+1);return e===t?w(124===t?Pe:Ae,2):61===e?w(Se,2):w(124===t?Me:ze,1)}function _(){var t=ft.charCodeAt(pt+1);return 61===t?w(Se,2):w(Te,1)}function g(t){var e=ft.charCodeAt(pt+1);return e===t?45==e&&62==ft.charCodeAt(pt+2)&&Je.test(ft.slice(At,pt))?(pt+=3,h(),u(),y()):w(ke,2):61===e?w(Se,2):w(Ne,1)}function v(t){var e=ft.charCodeAt(pt+1),n=1;return e===t?(n=62===t&&62===ft.charCodeAt(pt+2)?3:2,61===ft.charCodeAt(pt+n)?w(Se,n+1):w(Ee,n)):33==e&&60==t&&45==ft.charCodeAt(pt+2)&&45==ft.charCodeAt(pt+3)?(pt+=4,h(),u(),y()):(61===e&&(n=61===ft.charCodeAt(pt+2)?3:2),w(Le,n))}function p(t){var e=ft.charCodeAt(pt+1);return 61===e?w(Oe,61===ft.charCodeAt(pt+2)?3:2):w(61===t?Ce:Ie,1)}function m(t){switch(t){case 46:return l();case 40:return++pt,a(ge);case 41:return++pt,a(ve);case 59:return++pt,a(me);case 44:return++pt,a(pe);case 91:return++pt,a(ce);case 93:return++pt,a(fe);case 123:return++pt,a(de);case 125:return++pt,a(_e);case 58:return++pt,a(ye);case 63:return++pt,a(xe);case 48:var e=ft.charCodeAt(pt+1);if(120===e||88===e)return C();case 49:case 50:case 51:case 52:case 53:case 54:case 55:case 56:case 57:return S(!1);case 34:case 39:return k(t);case 47:return c(t);case 37:case 42:return f();case 124:case 38:return d(t);case 94:return _();case 43:case 45:return g(t);case 60:case 62:return v(t);case 61:case 33:return p(t);case 126:return w(Ie,1)}return!1}function y(t){if(t?pt=mt+1:mt=pt,ct.locations&&(wt=new r),t)return x();if(pt>=dt)return a(Ft);var e=ft.charCodeAt(pt);if(Ke(e)||92===e)return A();var i=m(e);if(i===!1){var s=String.fromCharCode(e);if("\\"===s||$e.test(s))return A();n(pt,"Unexpected character '"+s+"'")}return i}function w(t,e){var n=ft.slice(pt,pt+e);pt+=e,a(t,n)}function x(){for(var t,e,i="",r=pt;;){pt>=dt&&n(r,"Unterminated regular expression");var s=ft.charAt(pt);if(Je.test(s)&&n(r,"Unterminated regular expression"),t)t=!1;else{if("["===s)e=!0;else if("]"===s&&e)e=!1;else if("/"===s&&!e)break;t="\\"===s}++pt}var i=ft.slice(r,pt);++pt;var o=P();o&&!/^[gmsiy]*$/.test(o)&&n(r,"Invalid regexp flag");try{var h=new RegExp(i,o)}catch(u){u instanceof SyntaxError&&n(r,u.message),n(u)}return a(Nt,h)}function b(t,e){for(var n=pt,i=0,r=0,s=null==e?1/0:e;r<s;++r){var a,o=ft.charCodeAt(pt);if(a=o>=97?o-97+10:o>=65?o-65+10:o>=48&&o<=57?o-48:1/0,a>=t)break;++pt,i=i*t+a}return pt===n||null!=e&&pt-n!==e?null:i}function C(){pt+=2;var t=b(16);return null==t&&n(mt+2,"Expected hexadecimal number"),Ke(ft.charCodeAt(pt))&&n(pt,"Identifier directly after number"),a(Et,t)}function S(t){var e=pt,i=!1,r=48===ft.charCodeAt(pt);t||null!==b(10)||n(e,"Invalid number"),46===ft.charCodeAt(pt)&&(++pt,b(10),i=!0);var s=ft.charCodeAt(pt);69!==s&&101!==s||(s=ft.charCodeAt(++pt),43!==s&&45!==s||++pt,null===b(10)&&n(e,"Invalid number"),i=!0),Ke(ft.charCodeAt(pt))&&n(pt,"Identifier directly after number");var o,h=ft.slice(e,pt);return i?o=parseFloat(h):r&&1!==h.length?/[89]/.test(h)||Ot?n(e,"Invalid number"):o=parseInt(h,8):o=parseInt(h,10),a(Et,o)}function k(t){pt++;for(var e="";;){pt>=dt&&n(mt,"Unterminated string constant");var i=ft.charCodeAt(pt);if(i===t)return++pt,a(Bt,e);if(92===i){i=ft.charCodeAt(++pt);var r=/^[0-7]+/.exec(ft.slice(pt,pt+3));for(r&&(r=r[0]);r&&parseInt(r,8)>255;)r=r.slice(0,-1);if("0"===r&&(r=null),++pt,r)Ot&&n(pt-2,"Octal literal in strict mode"),e+=String.fromCharCode(parseInt(r,8)),pt+=r.length-1;else switch(i){case 110:e+="\n";break;case 114:e+="\r";break;case 120:e+=String.fromCharCode(I(2));break;case 117:e+=String.fromCharCode(I(4));break;case 85:e+=String.fromCharCode(I(8));break;case 116:e+="\t";break;case 98:e+="\b";break;case 118:e+="\x0B";break;case 102:e+="\f";break;case 48:e+="\0";break;case 13:10===ft.charCodeAt(pt)&&++pt;case 10:ct.locations&&(It=pt,++kt);break;default:e+=String.fromCharCode(i)}}else 13!==i&&10!==i&&8232!==i&&8233!==i||n(mt,"Unterminated string constant"),e+=String.fromCharCode(i),++pt}}function I(t){var e=b(16,t);return null===e&&n(mt,"Bad character escape sequence"),e}function P(){Fe=!1;for(var t,e=!0,i=pt;;){var r=ft.charCodeAt(pt);if(Ye(r))Fe&&(t+=ft.charAt(pt)),++pt;else{if(92!==r)break;Fe||(t=ft.slice(i,pt)),Fe=!0,117!=ft.charCodeAt(++pt)&&n(pt,"Expecting Unicode escape sequence \\uXXXX"),++pt;var s=I(4),a=String.fromCharCode(s);a||n(pt-1,"Invalid Unicode escape"),(e?Ke(s):Ye(s))||n(pt-4,"Invalid Unicode escape"),t+=a}e=!1}return Fe?t:ft.slice(i,pt)}function A(){var t=P(),e=jt;return!Fe&&Ue(t)&&(e=le[t]),a(e,t)}function M(){Pt=mt,At=yt,Mt=xt,y()}function T(t){if(Ot=t,pt=mt,ct.locations)for(;pt<It;)It=ft.lastIndexOf("\n",It-2)+1,--kt;u(),y()}function z(){this.type=null,this.start=mt,this.end=null}function O(){this.start=wt,this.end=null,null!==_t&&(this.source=_t)}function L(){var t=new z;return ct.locations&&(t.loc=new O),ct.directSourceFile&&(t.sourceFile=ct.directSourceFile),ct.ranges&&(t.range=[mt,0]),t}function E(t){var e=new z;return e.start=t.start,ct.locations&&(e.loc=new O,e.loc.start=t.loc.start),ct.ranges&&(e.range=[t.range[0],0]),e}function N(t,e){return t.type=e,t.end=At,ct.locations&&(t.loc.end=Mt),ct.ranges&&(t.range[1]=At),t}function B(t){return ct.ecmaVersion>=5&&"ExpressionStatement"===t.type&&"Literal"===t.expression.type&&"use strict"===t.expression.value}function j(t){if(bt===t)return M(),!0}function F(){return!ct.strictSemicolons&&(bt===Ft||bt===_e||Je.test(ft.slice(At,mt)))}function D(){j(me)||F()||q()}function R(t){bt===t?M():q()}function q(){n(mt,"Unexpected token")}function V(t){"Identifier"!==t.type&&"MemberExpression"!==t.type&&n(t.start,"Assigning to rvalue"),Ot&&"Identifier"===t.type&&Ve(t.name)&&n(t.start,"Assigning to "+t.name+" in strict mode")}function U(t){Pt=At=pt,ct.locations&&(Mt=new r),Tt=Ot=null,zt=[],y();var e=t||L(),n=!0;for(t||(e.body=[]);bt!==Ft;){var i=H();e.body.push(i),n&&B(i)&&T(!0),n=!1}return N(e,"Program")}function H(){(bt===be||bt===Se&&"/="==Ct)&&y(!0);var t=bt,e=L();switch(t){case Dt:case Vt:M();var i=t===Dt;j(me)||F()?e.label=null:bt!==jt?q():(e.label=lt(),D());for(var r=0;r<zt.length;++r){var s=zt[r];if(null==e.label||s.name===e.label.name){if(null!=s.kind&&(i||"loop"===s.kind))break;if(e.label&&i)break}}return r===zt.length&&n(e.start,"Unsyntactic "+t.keyword),N(e,i?"BreakStatement":"ContinueStatement");case Ut:return M(),D(),N(e,"DebuggerStatement");case Zt:return M(),zt.push(Qe),e.body=H(),zt.pop(),R(ne),e.test=Z(),D(),N(e,"DoWhileStatement");case Gt:if(M(),zt.push(Qe),R(ge),bt===me)return $(e,null);if(bt===ee){var a=L();return M(),J(a,!0),N(a,"VariableDeclaration"),1===a.declarations.length&&j(ue)?G(e,a):$(e,a)}var a=X(!1,!0);return j(ue)?(V(a),G(e,a)):$(e,a);case Jt:return M(),ht(e,!0);case Xt:return M(),e.test=Z(),e.consequent=H(),e.alternate=j(Wt)?H():null,N(e,"IfStatement");case Kt:return Tt||ct.allowReturnOutsideFunction||n(mt,"'return' outside of function"),M(),j(me)||F()?e.argument=null:(e.argument=X(),D()),N(e,"ReturnStatement");case Yt:M(),e.discriminant=Z(),e.cases=[],R(de),zt.push(tn);for(var o,h;bt!=_e;)if(bt===Rt||bt===Ht){var u=bt===Rt;o&&N(o,"SwitchCase"),e.cases.push(o=L()),o.consequent=[],M(),u?o.test=X():(h&&n(Pt,"Multiple default clauses"),h=!0,o.test=null),R(ye)}else o||q(),o.consequent.push(H());return o&&N(o,"SwitchCase"),M(),zt.pop(),N(e,"SwitchStatement");case Qt:return M(),Je.test(ft.slice(At,mt))&&n(At,"Illegal newline after throw"),e.argument=X(),D(),N(e,"ThrowStatement");case te:if(M(),e.block=W(),e.handler=null,bt===qt){var l=L();M(),R(ge),l.param=lt(),Ot&&Ve(l.param.name)&&n(l.param.start,"Binding "+l.param.name+" in strict mode"),R(ve),l.guard=null,l.body=W(),e.handler=N(l,"CatchClause")}return e.guardedHandlers=Lt,e.finalizer=j($t)?W():null,e.handler||e.finalizer||n(e.start,"Missing catch or finally clause"),N(e,"TryStatement");case ee:return M(),J(e),D(),N(e,"VariableDeclaration");case ne:return M(),e.test=Z(),zt.push(Qe),e.body=H(),zt.pop(),N(e,"WhileStatement");case ie:return Ot&&n(mt,"'with' in strict mode"),M(),e.object=Z(),e.body=H(),N(e,"WithStatement");case de:return W();case me:return M(),N(e,"EmptyStatement");default:var c=Ct,f=X();if(t===jt&&"Identifier"===f.type&&j(ye)){for(var r=0;r<zt.length;++r)zt[r].name===c&&n(f.start,"Label '"+c+"' is already declared");var d=bt.isLoop?"loop":bt===Yt?"switch":null;return zt.push({name:c,kind:d}),e.body=H(),zt.pop(),e.label=f,N(e,"LabeledStatement")}return e.expression=f,D(),N(e,"ExpressionStatement")}}function Z(){R(ge);var t=X();return R(ve),t}function W(t){var e,n=L(),i=!0,r=!1;for(n.body=[],R(de);!j(_e);){var s=H();n.body.push(s),i&&t&&B(s)&&(e=r,T(r=!0)),i=!1}return r&&!e&&T(!1),N(n,"BlockStatement")}function $(t,e){return t.init=e,R(me),t.test=bt===me?null:X(),R(me),t.update=bt===ve?null:X(),R(ve),t.body=H(),zt.pop(),N(t,"ForStatement")}function G(t,e){return t.left=e,t.right=X(),R(ve),t.body=H(),zt.pop(),N(t,"ForInStatement")}function J(t,e){for(t.declarations=[],t.kind="var";;){var i=L();if(i.id=lt(),Ot&&Ve(i.id.name)&&n(i.id.start,"Binding "+i.id.name+" in strict mode"),i.init=j(Ce)?X(!0,e):null,t.declarations.push(N(i,"VariableDeclarator")),!j(pe))break}return t}function X(t,e){var n=K(e);if(!t&&bt===pe){var i=E(n);for(i.expressions=[n];j(pe);)i.expressions.push(K(e));return N(i,"SequenceExpression")}return n}function K(t){var e=Y(t);if(bt.isAssign){var n=E(e);return n.operator=Ct,n.left=e,M(),n.right=K(t),V(e),N(n,"AssignmentExpression")}return e}function Y(t){var e=Q(t);if(j(xe)){var n=E(e);return n.test=e,n.consequent=X(!0),R(ye),n.alternate=X(!0,t),N(n,"ConditionalExpression")}return e}function Q(t){return tt(et(),-1,t)}function tt(t,e,n){var i=bt.binop;if(null!=i&&(!n||bt!==ue)&&i>e){var r=E(t);r.left=t,r.operator=Ct;var s=bt;M(),r.right=tt(et(),i,n);var a=N(r,s===Pe||s===Ae?"LogicalExpression":"BinaryExpression");return tt(a,e,n)}return t}function et(){if(bt.prefix){var t=L(),e=bt.isUpdate;return t.operator=Ct,t.prefix=!0,St=!0,M(),t.argument=et(),e?V(t.argument):Ot&&"delete"===t.operator&&"Identifier"===t.argument.type&&n(t.start,"Deleting local variable in strict mode"),N(t,e?"UpdateExpression":"UnaryExpression")}for(var i=nt();bt.postfix&&!F();){var t=E(i);t.operator=Ct,t.prefix=!1,t.argument=i,V(i),M(),i=N(t,"UpdateExpression")}return i}function nt(){return it(rt())}function it(t,e){if(j(we)){var n=E(t);return n.object=t,n.property=lt(!0),n.computed=!1,it(N(n,"MemberExpression"),e)}if(j(ce)){var n=E(t);return n.object=t,n.property=X(),n.computed=!0,R(fe),it(N(n,"MemberExpression"),e)}if(!e&&j(ge)){var n=E(t);return n.callee=t,n.arguments=ut(ve,!1),it(N(n,"CallExpression"),e)}return t}function rt(){switch(bt){case se:var t=L();return M(),N(t,"ThisExpression");case jt:return lt();case Et:case Bt:case Nt:var t=L();return t.value=Ct,t.raw=ft.slice(mt,yt),M(),N(t,"Literal");case ae:case oe:case he:var t=L();return t.value=bt.atomValue,t.raw=bt.keyword,M(),N(t,"Literal");case ge:var e=wt,n=mt;M();var i=X();return i.start=n,i.end=yt,ct.locations&&(i.loc.start=e,i.loc.end=xt),ct.ranges&&(i.range=[n,yt]),R(ve),i;case ce:var t=L();return M(),t.elements=ut(fe,!0,!0),N(t,"ArrayExpression");case de:return at();case Jt:var t=L();return M(),ht(t,!1);case re:return st();default:q()}}function st(){var t=L();return M(),t.callee=it(rt(),!0),j(ge)?t.arguments=ut(ve,!1):t.arguments=Lt,N(t,"NewExpression")}function at(){var t=L(),e=!0,i=!1;for(t.properties=[],M();!j(_e);){if(e)e=!1;else if(R(pe),ct.allowTrailingCommas&&j(_e))break;var r,s={key:ot()},a=!1;if(j(ye)?(s.value=X(!0),r=s.kind="init"):ct.ecmaVersion>=5&&"Identifier"===s.key.type&&("get"===s.key.name||"set"===s.key.name)?(a=i=!0,r=s.kind=s.key.name,s.key=ot(),bt!==ge&&q(),s.value=ht(L(),!1)):q(),"Identifier"===s.key.type&&(Ot||i))for(var o=0;o<t.properties.length;++o){var h=t.properties[o];if(h.key.name===s.key.name){var u=r==h.kind||a&&"init"===h.kind||"init"===r&&("get"===h.kind||"set"===h.kind);u&&!Ot&&"init"===r&&"init"===h.kind&&(u=!1),u&&n(s.key.start,"Redefinition of property")}}t.properties.push(s)}return N(t,"ObjectExpression")}function ot(){return bt===Et||bt===Bt?rt():lt(!0)}function ht(t,e){bt===jt?t.id=lt():e?q():t.id=null,t.params=[];var i=!0;for(R(ge);!j(ve);)i?i=!1:R(pe),t.params.push(lt());var r=Tt,s=zt;if(Tt=!0,zt=[],t.body=W(!0),Tt=r,zt=s,Ot||t.body.body.length&&B(t.body.body[0]))for(var a=t.id?-1:0;a<t.params.length;++a){var o=a<0?t.id:t.params[a];if((qe(o.name)||Ve(o.name))&&n(o.start,"Defining '"+o.name+"' in strict mode"),a>=0)for(var h=0;h<a;++h)o.name===t.params[h].name&&n(o.start,"Argument name clash in strict mode")}return N(t,e?"FunctionDeclaration":"FunctionExpression")}function ut(t,e,n){for(var i=[],r=!0;!j(t);){if(r)r=!1;else if(R(pe),e&&ct.allowTrailingCommas&&j(t))break;n&&bt===pe?i.push(null):i.push(X(!0))}return i}function lt(t){var e=L();return t&&"everywhere"==ct.forbidReserved&&(t=!1),bt===jt?(!t&&(ct.forbidReserved&&(3===ct.ecmaVersion?De:Re)(Ct)||Ot&&qe(Ct))&&ft.slice(mt,yt).indexOf("\\")==-1&&n(mt,"The keyword '"+Ct+"' is reserved"),e.name=Ct):t&&bt.keyword?e.name=bt.keyword:q(),St=!1,M(),N(e,"Identifier")}t.version="0.5.0";var ct,ft,dt,_t;t.parse=function(t,n){return ft=String(t),dt=ft.length,e(n),s(),U(ct.program)};var gt=t.defaultOptions={ecmaVersion:5,strictSemicolons:!1,allowTrailingCommas:!0,forbidReserved:!1,allowReturnOutsideFunction:!1,locations:!1,onComment:null,ranges:!1,program:null,sourceFile:null,directSourceFile:null},vt=t.getLineInfo=function(t,e){for(var n=1,i=0;;){Xe.lastIndex=i;var r=Xe.exec(t);if(!(r&&r.index<e))break;++n,i=r.index+r[0].length}return{line:n,column:e-i}};t.tokenize=function(t,n){function i(t){return At=yt,y(t),r.start=mt,r.end=yt,r.startLoc=wt,r.endLoc=xt,r.type=bt,r.value=Ct,r}ft=String(t),dt=ft.length,e(n),s();var r={};return i.jumpTo=function(t,e){if(pt=t,ct.locations){kt=1,It=Xe.lastIndex=0;for(var n;(n=Xe.exec(ft))&&n.index<t;)++kt,It=n.index+n[0].length}St=e,u()},i};var pt,mt,yt,wt,xt,bt,Ct,St,kt,It,Pt,At,Mt,Tt,zt,Ot,Lt=[],Et={type:"num"},Nt={type:"regexp"},Bt={type:"string"},jt={type:"name"},Ft={type:"eof"},Dt={keyword:"break"},Rt={keyword:"case",beforeExpr:!0},qt={keyword:"catch"},Vt={keyword:"continue"},Ut={keyword:"debugger"},Ht={keyword:"default"},Zt={keyword:"do",isLoop:!0},Wt={keyword:"else",beforeExpr:!0},$t={keyword:"finally"},Gt={keyword:"for",isLoop:!0},Jt={keyword:"function"},Xt={keyword:"if"},Kt={keyword:"return",beforeExpr:!0},Yt={keyword:"switch"},Qt={keyword:"throw",beforeExpr:!0},te={keyword:"try"},ee={keyword:"var"},ne={keyword:"while",isLoop:!0},ie={keyword:"with"},re={keyword:"new",beforeExpr:!0},se={keyword:"this"},ae={keyword:"null",atomValue:null},oe={keyword:"true",atomValue:!0},he={keyword:"false",atomValue:!1},ue={keyword:"in",binop:7,beforeExpr:!0},le={"break":Dt,"case":Rt,"catch":qt,"continue":Vt,"debugger":Ut,"default":Ht,"do":Zt,"else":Wt,"finally":$t,"for":Gt,"function":Jt,"if":Xt,"return":Kt,"switch":Yt,"throw":Qt,"try":te,"var":ee,"while":ne,"with":ie,"null":ae,"true":oe,"false":he,"new":re,"in":ue,"instanceof":{keyword:"instanceof",binop:7,beforeExpr:!0},"this":se,"typeof":{keyword:"typeof",prefix:!0,beforeExpr:!0},"void":{keyword:"void",prefix:!0,beforeExpr:!0},"delete":{keyword:"delete",prefix:!0,beforeExpr:!0}},ce={type:"[",beforeExpr:!0},fe={type:"]"},de={type:"{",beforeExpr:!0},_e={type:"}"},ge={type:"(",beforeExpr:!0},ve={type:")"},pe={type:",",beforeExpr:!0},me={type:";",beforeExpr:!0},ye={type:":",beforeExpr:!0},we={type:"."},xe={type:"?",beforeExpr:!0},be={binop:10,beforeExpr:!0},Ce={isAssign:!0,beforeExpr:!0},Se={isAssign:!0,beforeExpr:!0},ke={postfix:!0,prefix:!0,isUpdate:!0},Ie={prefix:!0,beforeExpr:!0},Pe={binop:1,beforeExpr:!0},Ae={binop:2,beforeExpr:!0},Me={binop:3,beforeExpr:!0},Te={binop:4,beforeExpr:!0},ze={binop:5,beforeExpr:!0},Oe={binop:6,beforeExpr:!0},Le={binop:7,beforeExpr:!0},Ee={binop:8,beforeExpr:!0},Ne={binop:9,prefix:!0,beforeExpr:!0},Be={binop:10,beforeExpr:!0};t.tokTypes={bracketL:ce,bracketR:fe,braceL:de,braceR:_e,parenL:ge,parenR:ve,comma:pe,semi:me,colon:ye,dot:we,question:xe,slash:be,eq:Ce,name:jt,eof:Ft,num:Et,regexp:Nt,string:Bt};for(var je in le)t.tokTypes["_"+je]=le[je];var Fe,De=i("abstract boolean byte char class double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile"),Re=i("class enum extends super const export import"),qe=i("implements interface let package private protected public static yield"),Ve=i("eval arguments"),Ue=i("break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this"),He=/[\u1680\u180e\u2000-\u200a\u202f\u205f\u3000\ufeff]/,Ze="\xaa\xb5\xba\xc0-\xd6\xd8-\xf6\xf8-\u02c1\u02c6-\u02d1\u02e0-\u02e4\u02ec\u02ee\u0370-\u0374\u0376\u0377\u037a-\u037d\u0386\u0388-\u038a\u038c\u038e-\u03a1\u03a3-\u03f5\u03f7-\u0481\u048a-\u0527\u0531-\u0556\u0559\u0561-\u0587\u05d0-\u05ea\u05f0-\u05f2\u0620-\u064a\u066e\u066f\u0671-\u06d3\u06d5\u06e5\u06e6\u06ee\u06ef\u06fa-\u06fc\u06ff\u0710\u0712-\u072f\u074d-\u07a5\u07b1\u07ca-\u07ea\u07f4\u07f5\u07fa\u0800-\u0815\u081a\u0824\u0828\u0840-\u0858\u08a0\u08a2-\u08ac\u0904-\u0939\u093d\u0950\u0958-\u0961\u0971-\u0977\u0979-\u097f\u0985-\u098c\u098f\u0990\u0993-\u09a8\u09aa-\u09b0\u09b2\u09b6-\u09b9\u09bd\u09ce\u09dc\u09dd\u09df-\u09e1\u09f0\u09f1\u0a05-\u0a0a\u0a0f\u0a10\u0a13-\u0a28\u0a2a-\u0a30\u0a32\u0a33\u0a35\u0a36\u0a38\u0a39\u0a59-\u0a5c\u0a5e\u0a72-\u0a74\u0a85-\u0a8d\u0a8f-\u0a91\u0a93-\u0aa8\u0aaa-\u0ab0\u0ab2\u0ab3\u0ab5-\u0ab9\u0abd\u0ad0\u0ae0\u0ae1\u0b05-\u0b0c\u0b0f\u0b10\u0b13-\u0b28\u0b2a-\u0b30\u0b32\u0b33\u0b35-\u0b39\u0b3d\u0b5c\u0b5d\u0b5f-\u0b61\u0b71\u0b83\u0b85-\u0b8a\u0b8e-\u0b90\u0b92-\u0b95\u0b99\u0b9a\u0b9c\u0b9e\u0b9f\u0ba3\u0ba4\u0ba8-\u0baa\u0bae-\u0bb9\u0bd0\u0c05-\u0c0c\u0c0e-\u0c10\u0c12-\u0c28\u0c2a-\u0c33\u0c35-\u0c39\u0c3d\u0c58\u0c59\u0c60\u0c61\u0c85-\u0c8c\u0c8e-\u0c90\u0c92-\u0ca8\u0caa-\u0cb3\u0cb5-\u0cb9\u0cbd\u0cde\u0ce0\u0ce1\u0cf1\u0cf2\u0d05-\u0d0c\u0d0e-\u0d10\u0d12-\u0d3a\u0d3d\u0d4e\u0d60\u0d61\u0d7a-\u0d7f\u0d85-\u0d96\u0d9a-\u0db1\u0db3-\u0dbb\u0dbd\u0dc0-\u0dc6\u0e01-\u0e30\u0e32\u0e33\u0e40-\u0e46\u0e81\u0e82\u0e84\u0e87\u0e88\u0e8a\u0e8d\u0e94-\u0e97\u0e99-\u0e9f\u0ea1-\u0ea3\u0ea5\u0ea7\u0eaa\u0eab\u0ead-\u0eb0\u0eb2\u0eb3\u0ebd\u0ec0-\u0ec4\u0ec6\u0edc-\u0edf\u0f00\u0f40-\u0f47\u0f49-\u0f6c\u0f88-\u0f8c\u1000-\u102a\u103f\u1050-\u1055\u105a-\u105d\u1061\u1065\u1066\u106e-\u1070\u1075-\u1081\u108e\u10a0-\u10c5\u10c7\u10cd\u10d0-\u10fa\u10fc-\u1248\u124a-\u124d\u1250-\u1256\u1258\u125a-\u125d\u1260-\u1288\u128a-\u128d\u1290-\u12b0\u12b2-\u12b5\u12b8-\u12be\u12c0\u12c2-\u12c5\u12c8-\u12d6\u12d8-\u1310\u1312-\u1315\u1318-\u135a\u1380-\u138f\u13a0-\u13f4\u1401-\u166c\u166f-\u167f\u1681-\u169a\u16a0-\u16ea\u16ee-\u16f0\u1700-\u170c\u170e-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176c\u176e-\u1770\u1780-\u17b3\u17d7\u17dc\u1820-\u1877\u1880-\u18a8\u18aa\u18b0-\u18f5\u1900-\u191c\u1950-\u196d\u1970-\u1974\u1980-\u19ab\u19c1-\u19c7\u1a00-\u1a16\u1a20-\u1a54\u1aa7\u1b05-\u1b33\u1b45-\u1b4b\u1b83-\u1ba0\u1bae\u1baf\u1bba-\u1be5\u1c00-\u1c23\u1c4d-\u1c4f\u1c5a-\u1c7d\u1ce9-\u1cec\u1cee-\u1cf1\u1cf5\u1cf6\u1d00-\u1dbf\u1e00-\u1f15\u1f18-\u1f1d\u1f20-\u1f45\u1f48-\u1f4d\u1f50-\u1f57\u1f59\u1f5b\u1f5d\u1f5f-\u1f7d\u1f80-\u1fb4\u1fb6-\u1fbc\u1fbe\u1fc2-\u1fc4\u1fc6-\u1fcc\u1fd0-\u1fd3\u1fd6-\u1fdb\u1fe0-\u1fec\u1ff2-\u1ff4\u1ff6-\u1ffc\u2071\u207f\u2090-\u209c\u2102\u2107\u210a-\u2113\u2115\u2119-\u211d\u2124\u2126\u2128\u212a-\u212d\u212f-\u2139\u213c-\u213f\u2145-\u2149\u214e\u2160-\u2188\u2c00-\u2c2e\u2c30-\u2c5e\u2c60-\u2ce4\u2ceb-\u2cee\u2cf2\u2cf3\u2d00-\u2d25\u2d27\u2d2d\u2d30-\u2d67\u2d6f\u2d80-\u2d96\u2da0-\u2da6\u2da8-\u2dae\u2db0-\u2db6\u2db8-\u2dbe\u2dc0-\u2dc6\u2dc8-\u2dce\u2dd0-\u2dd6\u2dd8-\u2dde\u2e2f\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303c\u3041-\u3096\u309d-\u309f\u30a1-\u30fa\u30fc-\u30ff\u3105-\u312d\u3131-\u318e\u31a0-\u31ba\u31f0-\u31ff\u3400-\u4db5\u4e00-\u9fcc\ua000-\ua48c\ua4d0-\ua4fd\ua500-\ua60c\ua610-\ua61f\ua62a\ua62b\ua640-\ua66e\ua67f-\ua697\ua6a0-\ua6ef\ua717-\ua71f\ua722-\ua788\ua78b-\ua78e\ua790-\ua793\ua7a0-\ua7aa\ua7f8-\ua801\ua803-\ua805\ua807-\ua80a\ua80c-\ua822\ua840-\ua873\ua882-\ua8b3\ua8f2-\ua8f7\ua8fb\ua90a-\ua925\ua930-\ua946\ua960-\ua97c\ua984-\ua9b2\ua9cf\uaa00-\uaa28\uaa40-\uaa42\uaa44-\uaa4b\uaa60-\uaa76\uaa7a\uaa80-\uaaaf\uaab1\uaab5\uaab6\uaab9-\uaabd\uaac0\uaac2\uaadb-\uaadd\uaae0-\uaaea\uaaf2-\uaaf4\uab01-\uab06\uab09-\uab0e\uab11-\uab16\uab20-\uab26\uab28-\uab2e\uabc0-\uabe2\uac00-\ud7a3\ud7b0-\ud7c6\ud7cb-\ud7fb\uf900-\ufa6d\ufa70-\ufad9\ufb00-\ufb06\ufb13-\ufb17\ufb1d\ufb1f-\ufb28\ufb2a-\ufb36\ufb38-\ufb3c\ufb3e\ufb40\ufb41\ufb43\ufb44\ufb46-\ufbb1\ufbd3-\ufd3d\ufd50-\ufd8f\ufd92-\ufdc7\ufdf0-\ufdfb\ufe70-\ufe74\ufe76-\ufefc\uff21-\uff3a\uff41-\uff5a\uff66-\uffbe\uffc2-\uffc7\uffca-\uffcf\uffd2-\uffd7\uffda-\uffdc",We="\u0300-\u036f\u0483-\u0487\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u0620-\u0649\u0672-\u06d3\u06e7-\u06e8\u06fb-\u06fc\u0730-\u074a\u0800-\u0814\u081b-\u0823\u0825-\u0827\u0829-\u082d\u0840-\u0857\u08e4-\u08fe\u0900-\u0903\u093a-\u093c\u093e-\u094f\u0951-\u0957\u0962-\u0963\u0966-\u096f\u0981-\u0983\u09bc\u09be-\u09c4\u09c7\u09c8\u09d7\u09df-\u09e0\u0a01-\u0a03\u0a3c\u0a3e-\u0a42\u0a47\u0a48\u0a4b-\u0a4d\u0a51\u0a66-\u0a71\u0a75\u0a81-\u0a83\u0abc\u0abe-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd\u0ae2-\u0ae3\u0ae6-\u0aef\u0b01-\u0b03\u0b3c\u0b3e-\u0b44\u0b47\u0b48\u0b4b-\u0b4d\u0b56\u0b57\u0b5f-\u0b60\u0b66-\u0b6f\u0b82\u0bbe-\u0bc2\u0bc6-\u0bc8\u0bca-\u0bcd\u0bd7\u0be6-\u0bef\u0c01-\u0c03\u0c46-\u0c48\u0c4a-\u0c4d\u0c55\u0c56\u0c62-\u0c63\u0c66-\u0c6f\u0c82\u0c83\u0cbc\u0cbe-\u0cc4\u0cc6-\u0cc8\u0cca-\u0ccd\u0cd5\u0cd6\u0ce2-\u0ce3\u0ce6-\u0cef\u0d02\u0d03\u0d46-\u0d48\u0d57\u0d62-\u0d63\u0d66-\u0d6f\u0d82\u0d83\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf\u0df2\u0df3\u0e34-\u0e3a\u0e40-\u0e45\u0e50-\u0e59\u0eb4-\u0eb9\u0ec8-\u0ecd\u0ed0-\u0ed9\u0f18\u0f19\u0f20-\u0f29\u0f35\u0f37\u0f39\u0f41-\u0f47\u0f71-\u0f84\u0f86-\u0f87\u0f8d-\u0f97\u0f99-\u0fbc\u0fc6\u1000-\u1029\u1040-\u1049\u1067-\u106d\u1071-\u1074\u1082-\u108d\u108f-\u109d\u135d-\u135f\u170e-\u1710\u1720-\u1730\u1740-\u1750\u1772\u1773\u1780-\u17b2\u17dd\u17e0-\u17e9\u180b-\u180d\u1810-\u1819\u1920-\u192b\u1930-\u193b\u1951-\u196d\u19b0-\u19c0\u19c8-\u19c9\u19d0-\u19d9\u1a00-\u1a15\u1a20-\u1a53\u1a60-\u1a7c\u1a7f-\u1a89\u1a90-\u1a99\u1b46-\u1b4b\u1b50-\u1b59\u1b6b-\u1b73\u1bb0-\u1bb9\u1be6-\u1bf3\u1c00-\u1c22\u1c40-\u1c49\u1c5b-\u1c7d\u1cd0-\u1cd2\u1d00-\u1dbe\u1e01-\u1f15\u200c\u200d\u203f\u2040\u2054\u20d0-\u20dc\u20e1\u20e5-\u20f0\u2d81-\u2d96\u2de0-\u2dff\u3021-\u3028\u3099\u309a\ua640-\ua66d\ua674-\ua67d\ua69f\ua6f0-\ua6f1\ua7f8-\ua800\ua806\ua80b\ua823-\ua827\ua880-\ua881\ua8b4-\ua8c4\ua8d0-\ua8d9\ua8f3-\ua8f7\ua900-\ua909\ua926-\ua92d\ua930-\ua945\ua980-\ua983\ua9b3-\ua9c0\uaa00-\uaa27\uaa40-\uaa41\uaa4c-\uaa4d\uaa50-\uaa59\uaa7b\uaae0-\uaae9\uaaf2-\uaaf3\uabc0-\uabe1\uabec\uabed\uabf0-\uabf9\ufb20-\ufb28\ufe00-\ufe0f\ufe20-\ufe26\ufe33\ufe34\ufe4d-\ufe4f\uff10-\uff19\uff3f",$e=new RegExp("["+Ze+"]"),Ge=new RegExp("["+Ze+We+"]"),Je=/[\n\r\u2028\u2029]/,Xe=/\r\n|[\n\r\u2028\u2029]/g,Ke=t.isIdentifierStart=function(t){
return t<65?36===t:t<91||(t<97?95===t:t<123||t>=170&&$e.test(String.fromCharCode(t)))},Ye=t.isIdentifierChar=function(t){return t<48?36===t:t<58||!(t<65)&&(t<91||(t<97?95===t:t<123||t>=170&&Ge.test(String.fromCharCode(t))))},Qe={kind:"loop"},tn={kind:"switch"}}),v.version||(v=null)}var w={"+":"__add","-":"__subtract","*":"__multiply","/":"__divide","%":"__modulo","==":"__equals","!=":"__equals"},x={"-":"__negate","+":"__self"},b=r.each(["add","subtract","multiply","divide","modulo","equals","negate"],function(t){this["__"+t]="#"+t},{__self:function(){return this}});return c.inject(b),d.inject(b),D.inject(b),n&&("complete"===i.readyState?setTimeout(f):H.add(n,{load:f})),{compile:h,execute:u,load:_,parse:e}}.call(this),paper=new(a.inject(r.exports,{Base:r,Numerical:u,Key:J,DomEvent:H,DomElement:U,document:i,window:n,Symbol:I,PlacedSymbol:k})),paper.agent.node&&require("./node/extend.js")(paper),"function"==typeof define&&define.amd?define("paper",paper):"object"==typeof module&&module&&(module.exports=paper),paper}.call(this,"object"==typeof self?self:null);!function(t,e){"object"==typeof exports&&"object"==typeof module?module.exports=e():"function"==typeof define&&define.amd?define("UnicodeBidirectional",[],e):"object"==typeof exports?exports.UnicodeBidirectional=e():t.UnicodeBidirectional=e()}(this,function(){return function(t){function e(r){if(u[r])return u[r].exports;var n=u[r]={i:r,l:!1,exports:{}};return t[r].call(n.exports,n,n.exports,e),n.l=!0,n.exports}var u={};return e.m=t,e.c=u,e.d=function(t,u,r){e.o(t,u)||Object.defineProperty(t,u,{configurable:!1,enumerable:!0,get:r})},e.n=function(t){var u=t&&t.__esModule?function(){return t.default}:function(){return t};return e.d(u,"a",u),u},e.o=function(t,e){return Object.prototype.hasOwnProperty.call(t,e)},e.p="",e(e.s=13)}([function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.isNonFormatting=e.isX9ControlCharacter=e.isStrong=e.isPDI=e.isIsolateInitiator=e.isR=e.isNI=e.isET=e.MAX_DEPTH=e.oppositeBracket=e.isClosingBracket=e.isOpeningBracket=e.RIGHT_CURLY=e.LEFT_CURLY=e.RIGHT_SQUARE=e.LEFT_SQUARE=e.RIGHT_PAR=e.LEFT_PAR=e.WS1=e.BN1=e.EN1=e.AN1=e.ON1=e.R1=e.L1=e.S1=e.B1=e.G=e.F=e.E=e.D=e.C=e.B=e.A=e.RLO=e.RLM=e.RLI=e.RLE=e.PDI=e.PDF=e.LRO=e.LRM=e.LRI=e.LRE=e.FSI=e.ALM=void 0;var r=function(t){return t&&t.__esModule?t:{default:t}}(u(2)),n=function(t){return(0,r.default)([40,91,123,9001,12296],t)?"Open":(0,r.default)([41,93,125,9002,12297],t)?"Close":"None"};e.ALM=1564,e.FSI=8296,e.LRE=8234,e.LRI=8294,e.LRM=8206,e.LRO=8237,e.PDF=8236,e.PDI=8297,e.RLE=8235,e.RLI=8295,e.RLM=8207,e.RLO=8238,e.A=65,e.B=66,e.C=67,e.D=68,e.E=69,e.F=70,e.G=71,e.B1=8233,e.S1=9,e.L1=109,e.R1=1488,e.ON1=34,e.AN1=1633,e.EN1=50,e.BN1=0,e.WS1=32,e.LEFT_PAR=40,e.RIGHT_PAR=41,e.LEFT_SQUARE=91,e.RIGHT_SQUARE=93,e.LEFT_CURLY=123,e.RIGHT_CURLY=125,e.isOpeningBracket=function(t,e){return"Open"===n(t)&&"ON"===e},e.isClosingBracket=function(t,e){return"Close"===n(t)&&"ON"===e},e.oppositeBracket=function(t){return 40==t?41:41==t?40:91==t?93:93==t?91:123==t?125:125==t?123:9001==t?9002:9002==t?9001:12296==t?12297:12297==t?12296:"None"},e.MAX_DEPTH=125,e.isET=function(t){return"ET"===t},e.isNI=function(t){return(0,r.default)(["B","S","WS","ON","FSI","LRI","RLI","PDI"],t)},e.isR=function(t){return(0,r.default)(["R","AN","EN"],t)},e.isIsolateInitiator=function(t){return(0,r.default)(["LRI","RLI","FSI"],t)},e.isPDI=function(t){return 8297===t},e.isStrong=function(t){return(0,r.default)(["L","R","AL"],t)},e.isX9ControlCharacter=function(t){return(0,r.default)(["RLE","LRE","RLO","LRO","PDF","BN"],t)},e.isNonFormatting=function(t){return(0,r.default)(["B","BN","RLE","LRE","RLO","LRO","PDF","RLI","LRI","FSI","PDI"],t)}},function(t,e,u){!function(e,u){t.exports=u()}(0,function(){"use strict";function t(t,e){e&&(t.prototype=Object.create(e.prototype)),t.prototype.constructor=t}function e(t){return i(t)?t:I(t)}function u(t){return o(t)?t:x(t)}function r(t){return a(t)?t:L(t)}function n(t){return i(t)&&!s(t)?t:O(t)}function i(t){return!(!t||!t[su])}function o(t){return!(!t||!t[fu])}function a(t){return!(!t||!t[cu])}function s(t){return o(t)||a(t)}function f(t){return!(!t||!t[Du])}function c(t){return t.value=!1,t}function D(t){t&&(t.value=!0)}function l(){}function h(t,e){e=e||0;for(var u=Math.max(0,t.length-e),r=new Array(u),n=0;n<u;n++)r[n]=t[n+e];return r}function p(t){return void 0===t.size&&(t.size=t.__iterate(_)),t.size}function d(t,e){if("number"!=typeof e){var u=e>>>0;if(""+u!==e||4294967295===u)return NaN;e=u}return e<0?p(t)+e:e}function _(){return!0}function v(t,e,u){return(0===t||void 0!==u&&t<=-u)&&(void 0===e||void 0!==u&&e>=u)}function F(t,e){return C(t,e,0)}function E(t,e){return C(t,e,e)}function C(t,e,u){return void 0===t?u:t<0?Math.max(0,e+t):void 0===e?t:Math.min(e,t)}function A(t){this.next=t}function y(t,e,u,r){var n=0===t?e:1===t?u:[e,u];return r?r.value=n:r={value:n,done:!1},r}function B(){return{value:void 0,done:!0}}function g(t){return!!w(t)}function m(t){return t&&"function"==typeof t.next}function S(t){var e=w(t);return e&&e.call(t)}function w(t){var e=t&&(Au&&t[Au]||t[yu]);if("function"==typeof e)return e}function b(t){return t&&"number"==typeof t.length}function I(t){return null===t||void 0===t?P():i(t)?t.toSeq():N(t)}function x(t){return null===t||void 0===t?P().toKeyedSeq():i(t)?o(t)?t.toSeq():t.fromEntrySeq():T(t)}function L(t){return null===t||void 0===t?P():i(t)?o(t)?t.entrySeq():t.toIndexedSeq():q(t)}function O(t){return(null===t||void 0===t?P():i(t)?o(t)?t.entrySeq():t:q(t)).toSetSeq()}function z(t){this._array=t,this.size=t.length}function M(t){var e=Object.keys(t);this._object=t,this._keys=e,this.size=e.length}function R(t){this._iterable=t,this.size=t.length||t.size}function k(t){this._iterator=t,this._iteratorCache=[]}function j(t){return!(!t||!t[gu])}function P(){return mu||(mu=new z([]))}function T(t){var e=Array.isArray(t)?new z(t).fromEntrySeq():m(t)?new k(t).fromEntrySeq():g(t)?new R(t).fromEntrySeq():"object"==typeof t?new M(t):void 0;if(!e)throw new TypeError("Expected Array or iterable object of [k, v] entries, or keyed object: "+t);return e}function q(t){var e=U(t);if(!e)throw new TypeError("Expected Array or iterable object of values: "+t);return e}function N(t){var e=U(t)||"object"==typeof t&&new M(t);if(!e)throw new TypeError("Expected Array or iterable object of values, or keyed object: "+t);return e}function U(t){return b(t)?new z(t):m(t)?new k(t):g(t)?new R(t):void 0}function W(t,e,u,r){var n=t._cache;if(n){for(var i=n.length-1,o=0;o<=i;o++){var a=n[u?i-o:o];if(!1===e(a[1],r?a[0]:o,t))return o+1}return o}return t.__iterateUncached(e,u)}function K(t,e,u,r){var n=t._cache;if(n){var i=n.length-1,o=0;return new A(function(){var t=n[u?i-o:o];return o++>i?B():y(e,r?t[0]:o-1,t[1])})}return t.__iteratorUncached(e,u)}function J(t,e){return e?H(e,t,"",{"":t}):X(t)}function H(t,e,u,r){return Array.isArray(e)?t.call(r,u,L(e).map(function(u,r){return H(t,u,r,e)})):G(e)?t.call(r,u,x(e).map(function(u,r){return H(t,u,r,e)})):e}function X(t){return Array.isArray(t)?L(t).map(X).toList():G(t)?x(t).map(X).toMap():t}function G(t){return t&&(t.constructor===Object||void 0===t.constructor)}function V(t,e){if(t===e||t!==t&&e!==e)return!0;if(!t||!e)return!1;if("function"==typeof t.valueOf&&"function"==typeof e.valueOf){if(t=t.valueOf(),e=e.valueOf(),t===e||t!==t&&e!==e)return!0;if(!t||!e)return!1}return!("function"!=typeof t.equals||"function"!=typeof e.equals||!t.equals(e))}function Y(t,e){if(t===e)return!0;if(!i(e)||void 0!==t.size&&void 0!==e.size&&t.size!==e.size||void 0!==t.__hash&&void 0!==e.__hash&&t.__hash!==e.__hash||o(t)!==o(e)||a(t)!==a(e)||f(t)!==f(e))return!1;if(0===t.size&&0===e.size)return!0;var u=!s(t);if(f(t)){var r=t.entries();return e.every(function(t,e){var n=r.next().value;return n&&V(n[1],t)&&(u||V(n[0],e))})&&r.next().done}var n=!1;if(void 0===t.size)if(void 0===e.size)"function"==typeof t.cacheResult&&t.cacheResult();else{n=!0;var c=t;t=e,e=c}var D=!0,l=e.__iterate(function(e,r){if(u?!t.has(e):n?!V(e,t.get(r,du)):!V(t.get(r,du),e))return D=!1,!1});return D&&t.size===l}function Q(t,e){if(!(this instanceof Q))return new Q(t,e);if(this._value=t,this.size=void 0===e?1/0:Math.max(0,e),0===this.size){if(Su)return Su;Su=this}}function $(t,e){if(!t)throw new Error(e)}function Z(t,e,u){if(!(this instanceof Z))return new Z(t,e,u);if($(0!==u,"Cannot step a Range by 0"),t=t||0,void 0===e&&(e=1/0),u=void 0===u?1:Math.abs(u),e<t&&(u=-u),this._start=t,this._end=e,this._step=u,this.size=Math.max(0,Math.ceil((e-t)/u-1)+1),0===this.size){if(wu)return wu;wu=this}}function tt(){throw TypeError("Abstract")}function et(){}function ut(){}function rt(){}function nt(t){return t>>>1&1073741824|3221225471&t}function it(t){if(!1===t||null===t||void 0===t)return 0;if("function"==typeof t.valueOf&&(!1===(t=t.valueOf())||null===t||void 0===t))return 0;if(!0===t)return 1;var e=typeof t;if("number"===e){if(t!==t||t===1/0)return 0;var u=0|t;for(u!==t&&(u^=4294967295*t);t>4294967295;)u^=t/=4294967295;return nt(u)}if("string"===e)return t.length>Ru?ot(t):at(t);if("function"==typeof t.hashCode)return t.hashCode();if("object"===e)return st(t);if("function"==typeof t.toString)return at(t.toString());throw new Error("Value type "+e+" cannot be hashed.")}function ot(t){var e=Pu[t];return void 0===e&&(e=at(t),ju===ku&&(ju=0,Pu={}),ju++,Pu[t]=e),e}function at(t){for(var e=0,u=0;u<t.length;u++)e=31*e+t.charCodeAt(u)|0;return nt(e)}function st(t){var e;if(Ou&&void 0!==(e=bu.get(t)))return e;if(void 0!==(e=t[Mu]))return e;if(!Lu){if(void 0!==(e=t.propertyIsEnumerable&&t.propertyIsEnumerable[Mu]))return e;if(void 0!==(e=ft(t)))return e}if(e=++zu,1073741824&zu&&(zu=0),Ou)bu.set(t,e);else{if(void 0!==xu&&!1===xu(t))throw new Error("Non-extensible objects are not allowed as keys.");if(Lu)Object.defineProperty(t,Mu,{enumerable:!1,configurable:!1,writable:!1,value:e});else if(void 0!==t.propertyIsEnumerable&&t.propertyIsEnumerable===t.constructor.prototype.propertyIsEnumerable)t.propertyIsEnumerable=function(){return this.constructor.prototype.propertyIsEnumerable.apply(this,arguments)},t.propertyIsEnumerable[Mu]=e;else{if(void 0===t.nodeType)throw new Error("Unable to set a non-enumerable property on object.");t[Mu]=e}}return e}function ft(t){if(t&&t.nodeType>0)switch(t.nodeType){case 1:return t.uniqueID;case 9:return t.documentElement&&t.documentElement.uniqueID}}function ct(t){$(t!==1/0,"Cannot perform this action with an infinite size.")}function Dt(t){return null===t||void 0===t?yt():lt(t)&&!f(t)?t:yt().withMutations(function(e){var r=u(t);ct(r.size),r.forEach(function(t,u){return e.set(u,t)})})}function lt(t){return!(!t||!t[Tu])}function ht(t,e){this.ownerID=t,this.entries=e}function pt(t,e,u){this.ownerID=t,this.bitmap=e,this.nodes=u}function dt(t,e,u){this.ownerID=t,this.count=e,this.nodes=u}function _t(t,e,u){this.ownerID=t,this.keyHash=e,this.entries=u}function vt(t,e,u){this.ownerID=t,this.keyHash=e,this.entry=u}function Ft(t,e,u){this._type=e,this._reverse=u,this._stack=t._root&&Ct(t._root)}function Et(t,e){return y(t,e[0],e[1])}function Ct(t,e){return{node:t,index:0,__prev:e}}function At(t,e,u,r){var n=Object.create(qu);return n.size=t,n._root=e,n.__ownerID=u,n.__hash=r,n.__altered=!1,n}function yt(){return Nu||(Nu=At(0))}function Bt(t,e,u){var r,n;if(t._root){var i=c(_u),o=c(vu);if(r=gt(t._root,t.__ownerID,0,void 0,e,u,i,o),!o.value)return t;n=t.size+(i.value?u===du?-1:1:0)}else{if(u===du)return t;n=1,r=new ht(t.__ownerID,[[e,u]])}return t.__ownerID?(t.size=n,t._root=r,t.__hash=void 0,t.__altered=!0,t):r?At(n,r):yt()}function gt(t,e,u,r,n,i,o,a){return t?t.update(e,u,r,n,i,o,a):i===du?t:(D(a),D(o),new vt(e,r,[n,i]))}function mt(t){return t.constructor===vt||t.constructor===_t}function St(t,e,u,r,n){if(t.keyHash===r)return new _t(e,r,[t.entry,n]);var i,o=(0===u?t.keyHash:t.keyHash>>>u)&pu,a=(0===u?r:r>>>u)&pu;return new pt(e,1<<o|1<<a,o===a?[St(t,e,u+lu,r,n)]:(i=new vt(e,r,n),o<a?[t,i]:[i,t]))}function wt(t,e,u,r){t||(t=new l);for(var n=new vt(t,it(u),[u,r]),i=0;i<e.length;i++){var o=e[i];n=n.update(t,0,void 0,o[0],o[1])}return n}function bt(t,e,u,r){for(var n=0,i=0,o=new Array(u),a=0,s=1,f=e.length;a<f;a++,s<<=1){var c=e[a];void 0!==c&&a!==r&&(n|=s,o[i++]=c)}return new pt(t,n,o)}function It(t,e,u,r,n){for(var i=0,o=new Array(hu),a=0;0!==u;a++,u>>>=1)o[a]=1&u?e[i++]:void 0;return o[r]=n,new dt(t,i+1,o)}function xt(t,e,r){for(var n=[],o=0;o<r.length;o++){var a=r[o],s=u(a);i(a)||(s=s.map(function(t){return J(t)})),n.push(s)}return zt(t,e,n)}function Lt(t,e,u){return t&&t.mergeDeep&&i(e)?t.mergeDeep(e):V(t,e)?t:e}function Ot(t){return function(e,u,r){if(e&&e.mergeDeepWith&&i(u))return e.mergeDeepWith(t,u);var n=t(e,u,r);return V(e,n)?e:n}}function zt(t,e,u){return 0===(u=u.filter(function(t){return 0!==t.size})).length?t:0!==t.size||t.__ownerID||1!==u.length?t.withMutations(function(t){for(var r=e?function(u,r){t.update(r,du,function(t){return t===du?u:e(t,u,r)})}:function(e,u){t.set(u,e)},n=0;n<u.length;n++)u[n].forEach(r)}):t.constructor(u[0])}function Mt(t,e,u,r){var n=t===du,i=e.next();if(i.done){var o=n?u:t,a=r(o);return a===o?t:a}$(n||t&&t.set,"invalid keyPath");var s=i.value,f=n?du:t.get(s,du),c=Mt(f,e,u,r);return c===f?t:c===du?t.remove(s):(n?yt():t).set(s,c)}function Rt(t){return t-=t>>1&1431655765,t=(858993459&t)+(t>>2&858993459),t=t+(t>>4)&252645135,t+=t>>8,127&(t+=t>>16)}function kt(t,e,u,r){var n=r?t:h(t);return n[e]=u,n}function jt(t,e,u,r){var n=t.length+1;if(r&&e+1===n)return t[e]=u,t;for(var i=new Array(n),o=0,a=0;a<n;a++)a===e?(i[a]=u,o=-1):i[a]=t[a+o];return i}function Pt(t,e,u){var r=t.length-1;if(u&&e===r)return t.pop(),t;for(var n=new Array(r),i=0,o=0;o<r;o++)o===e&&(i=1),n[o]=t[o+i];return n}function Tt(t){var e=Kt();if(null===t||void 0===t)return e;if(qt(t))return t;var u=r(t),n=u.size;return 0===n?e:(ct(n),n>0&&n<hu?Wt(0,n,lu,null,new Nt(u.toArray())):e.withMutations(function(t){t.setSize(n),u.forEach(function(e,u){return t.set(u,e)})}))}function qt(t){return!(!t||!t[Ju])}function Nt(t,e){this.array=t,this.ownerID=e}function Ut(t,e){function u(t,e,u){return 0===e?r(t,u):n(t,e,u)}function r(t,u){var r=u===a?s&&s.array:t&&t.array,n=u>i?0:i-u,f=o-u;return f>hu&&(f=hu),function(){if(n===f)return Gu;var t=e?--f:n++;return r&&r[t]}}function n(t,r,n){var a,s=t&&t.array,f=n>i?0:i-n>>r,c=1+(o-n>>r);return c>hu&&(c=hu),function(){for(;;){if(a){var t=a();if(t!==Gu)return t;a=null}if(f===c)return Gu;var i=e?--c:f++;a=u(s&&s[i],r-lu,n+(i<<r))}}}var i=t._origin,o=t._capacity,a=Qt(o),s=t._tail;return u(t._root,t._level,0)}function Wt(t,e,u,r,n,i,o){var a=Object.create(Hu);return a.size=e-t,a._origin=t,a._capacity=e,a._level=u,a._root=r,a._tail=n,a.__ownerID=i,a.__hash=o,a.__altered=!1,a}function Kt(){return Xu||(Xu=Wt(0,0,lu))}function Jt(t,e,u){if((e=d(t,e))!==e)return t;if(e>=t.size||e<0)return t.withMutations(function(t){e<0?Vt(t,e).set(0,u):Vt(t,0,e+1).set(e,u)});e+=t._origin;var r=t._tail,n=t._root,i=c(vu);return e>=Qt(t._capacity)?r=Ht(r,t.__ownerID,0,e,u,i):n=Ht(n,t.__ownerID,t._level,e,u,i),i.value?t.__ownerID?(t._root=n,t._tail=r,t.__hash=void 0,t.__altered=!0,t):Wt(t._origin,t._capacity,t._level,n,r):t}function Ht(t,e,u,r,n,i){var o=r>>>u&pu,a=t&&o<t.array.length;if(!a&&void 0===n)return t;var s;if(u>0){var f=t&&t.array[o],c=Ht(f,e,u-lu,r,n,i);return c===f?t:(s=Xt(t,e),s.array[o]=c,s)}return a&&t.array[o]===n?t:(D(i),s=Xt(t,e),void 0===n&&o===s.array.length-1?s.array.pop():s.array[o]=n,s)}function Xt(t,e){return e&&t&&e===t.ownerID?t:new Nt(t?t.array.slice():[],e)}function Gt(t,e){if(e>=Qt(t._capacity))return t._tail;if(e<1<<t._level+lu){for(var u=t._root,r=t._level;u&&r>0;)u=u.array[e>>>r&pu],r-=lu;return u}}function Vt(t,e,u){void 0!==e&&(e|=0),void 0!==u&&(u|=0);var r=t.__ownerID||new l,n=t._origin,i=t._capacity,o=n+e,a=void 0===u?i:u<0?i+u:n+u;if(o===n&&a===i)return t;if(o>=a)return t.clear();for(var s=t._level,f=t._root,c=0;o+c<0;)f=new Nt(f&&f.array.length?[void 0,f]:[],r),c+=1<<(s+=lu);c&&(o+=c,n+=c,a+=c,i+=c);for(var D=Qt(i),h=Qt(a);h>=1<<s+lu;)f=new Nt(f&&f.array.length?[f]:[],r),s+=lu;var p=t._tail,d=h<D?Gt(t,a-1):h>D?new Nt([],r):p;if(p&&h>D&&o<i&&p.array.length){for(var _=f=Xt(f,r),v=s;v>lu;v-=lu){var F=D>>>v&pu;_=_.array[F]=Xt(_.array[F],r)}_.array[D>>>lu&pu]=p}if(a<i&&(d=d&&d.removeAfter(r,0,a)),o>=h)o-=h,a-=h,s=lu,f=null,d=d&&d.removeBefore(r,0,o);else if(o>n||h<D){for(c=0;f;){var E=o>>>s&pu;if(E!==h>>>s&pu)break;E&&(c+=(1<<s)*E),s-=lu,f=f.array[E]}f&&o>n&&(f=f.removeBefore(r,s,o-c)),f&&h<D&&(f=f.removeAfter(r,s,h-c)),c&&(o-=c,a-=c)}return t.__ownerID?(t.size=a-o,t._origin=o,t._capacity=a,t._level=s,t._root=f,t._tail=d,t.__hash=void 0,t.__altered=!0,t):Wt(o,a,s,f,d)}function Yt(t,e,u){for(var n=[],o=0,a=0;a<u.length;a++){var s=u[a],f=r(s);f.size>o&&(o=f.size),i(s)||(f=f.map(function(t){return J(t)})),n.push(f)}return o>t.size&&(t=t.setSize(o)),zt(t,e,n)}function Qt(t){return t<hu?0:t-1>>>lu<<lu}function $t(t){return null===t||void 0===t?ee():Zt(t)?t:ee().withMutations(function(e){var r=u(t);ct(r.size),r.forEach(function(t,u){return e.set(u,t)})})}function Zt(t){return lt(t)&&f(t)}function te(t,e,u,r){var n=Object.create($t.prototype);return n.size=t?t.size:0,n._map=t,n._list=e,n.__ownerID=u,n.__hash=r,n}function ee(){return Vu||(Vu=te(yt(),Kt()))}function ue(t,e,u){var r,n,i=t._map,o=t._list,a=i.get(e),s=void 0!==a;if(u===du){if(!s)return t;o.size>=hu&&o.size>=2*i.size?(r=(n=o.filter(function(t,e){return void 0!==t&&a!==e})).toKeyedSeq().map(function(t){return t[0]}).flip().toMap(),t.__ownerID&&(r.__ownerID=n.__ownerID=t.__ownerID)):(r=i.remove(e),n=a===o.size-1?o.pop():o.set(a,void 0))}else if(s){if(u===o.get(a)[1])return t;r=i,n=o.set(a,[e,u])}else r=i.set(e,o.size),n=o.set(o.size,[e,u]);return t.__ownerID?(t.size=r.size,t._map=r,t._list=n,t.__hash=void 0,t):te(r,n)}function re(t,e){this._iter=t,this._useKeys=e,this.size=t.size}function ne(t){this._iter=t,this.size=t.size}function ie(t){this._iter=t,this.size=t.size}function oe(t){this._iter=t,this.size=t.size}function ae(t){var e=be(t);return e._iter=t,e.size=t.size,e.flip=function(){return t},e.reverse=function(){var e=t.reverse.apply(this);return e.flip=function(){return t.reverse()},e},e.has=function(e){return t.includes(e)},e.includes=function(e){return t.has(e)},e.cacheResult=Ie,e.__iterateUncached=function(e,u){var r=this;return t.__iterate(function(t,u){return!1!==e(u,t,r)},u)},e.__iteratorUncached=function(e,u){if(e===Cu){var r=t.__iterator(e,u);return new A(function(){var t=r.next();if(!t.done){var e=t.value[0];t.value[0]=t.value[1],t.value[1]=e}return t})}return t.__iterator(e===Eu?Fu:Eu,u)},e}function se(t,e,u){var r=be(t);return r.size=t.size,r.has=function(e){return t.has(e)},r.get=function(r,n){var i=t.get(r,du);return i===du?n:e.call(u,i,r,t)},r.__iterateUncached=function(r,n){var i=this;return t.__iterate(function(t,n,o){return!1!==r(e.call(u,t,n,o),n,i)},n)},r.__iteratorUncached=function(r,n){var i=t.__iterator(Cu,n);return new A(function(){var n=i.next();if(n.done)return n;var o=n.value,a=o[0];return y(r,a,e.call(u,o[1],a,t),n)})},r}function fe(t,e){var u=be(t);return u._iter=t,u.size=t.size,u.reverse=function(){return t},t.flip&&(u.flip=function(){var e=ae(t);return e.reverse=function(){return t.flip()},e}),u.get=function(u,r){return t.get(e?u:-1-u,r)},u.has=function(u){return t.has(e?u:-1-u)},u.includes=function(e){return t.includes(e)},u.cacheResult=Ie,u.__iterate=function(e,u){var r=this;return t.__iterate(function(t,u){return e(t,u,r)},!u)},u.__iterator=function(e,u){return t.__iterator(e,!u)},u}function ce(t,e,u,r){var n=be(t);return r&&(n.has=function(r){var n=t.get(r,du);return n!==du&&!!e.call(u,n,r,t)},n.get=function(r,n){var i=t.get(r,du);return i!==du&&e.call(u,i,r,t)?i:n}),n.__iterateUncached=function(n,i){var o=this,a=0;return t.__iterate(function(t,i,s){if(e.call(u,t,i,s))return a++,n(t,r?i:a-1,o)},i),a},n.__iteratorUncached=function(n,i){var o=t.__iterator(Cu,i),a=0;return new A(function(){for(;;){var i=o.next();if(i.done)return i;var s=i.value,f=s[0],c=s[1];if(e.call(u,c,f,t))return y(n,r?f:a++,c,i)}})},n}function De(t,e,u){var r=Dt().asMutable();return t.__iterate(function(n,i){r.update(e.call(u,n,i,t),0,function(t){return t+1})}),r.asImmutable()}function le(t,e,u){var r=o(t),n=(f(t)?$t():Dt()).asMutable();t.__iterate(function(i,o){n.update(e.call(u,i,o,t),function(t){return(t=t||[]).push(r?[o,i]:i),t})});var i=we(t);return n.map(function(e){return ge(t,i(e))})}function he(t,e,u,r){var n=t.size;if(void 0!==e&&(e|=0),void 0!==u&&(u===1/0?u=n:u|=0),v(e,u,n))return t;var i=F(e,n),o=E(u,n);if(i!==i||o!==o)return he(t.toSeq().cacheResult(),e,u,r);var a,s=o-i;s===s&&(a=s<0?0:s);var f=be(t);return f.size=0===a?a:t.size&&a||void 0,!r&&j(t)&&a>=0&&(f.get=function(e,u){return(e=d(this,e))>=0&&e<a?t.get(e+i,u):u}),f.__iterateUncached=function(e,u){var n=this;if(0===a)return 0;if(u)return this.cacheResult().__iterate(e,u);var o=0,s=!0,f=0;return t.__iterate(function(t,u){if(!s||!(s=o++<i))return f++,!1!==e(t,r?u:f-1,n)&&f!==a}),f},f.__iteratorUncached=function(e,u){if(0!==a&&u)return this.cacheResult().__iterator(e,u);var n=0!==a&&t.__iterator(e,u),o=0,s=0;return new A(function(){for(;o++<i;)n.next();if(++s>a)return B();var t=n.next();return r||e===Eu?t:e===Fu?y(e,s-1,void 0,t):y(e,s-1,t.value[1],t)})},f}function pe(t,e,u){var r=be(t);return r.__iterateUncached=function(r,n){var i=this;if(n)return this.cacheResult().__iterate(r,n);var o=0;return t.__iterate(function(t,n,a){return e.call(u,t,n,a)&&++o&&r(t,n,i)}),o},r.__iteratorUncached=function(r,n){var i=this;if(n)return this.cacheResult().__iterator(r,n);var o=t.__iterator(Cu,n),a=!0;return new A(function(){if(!a)return B();var t=o.next();if(t.done)return t;var n=t.value,s=n[0],f=n[1];return e.call(u,f,s,i)?r===Cu?t:y(r,s,f,t):(a=!1,B())})},r}function de(t,e,u,r){var n=be(t);return n.__iterateUncached=function(n,i){var o=this;if(i)return this.cacheResult().__iterate(n,i);var a=!0,s=0;return t.__iterate(function(t,i,f){if(!a||!(a=e.call(u,t,i,f)))return s++,n(t,r?i:s-1,o)}),s},n.__iteratorUncached=function(n,i){var o=this;if(i)return this.cacheResult().__iterator(n,i);var a=t.__iterator(Cu,i),s=!0,f=0;return new A(function(){var t,i,c;do{if((t=a.next()).done)return r||n===Eu?t:n===Fu?y(n,f++,void 0,t):y(n,f++,t.value[1],t);var D=t.value;i=D[0],c=D[1],s&&(s=e.call(u,c,i,o))}while(s);return n===Cu?t:y(n,i,c,t)})},n}function _e(t,e){var r=o(t),n=[t].concat(e).map(function(t){return i(t)?r&&(t=u(t)):t=r?T(t):q(Array.isArray(t)?t:[t]),t}).filter(function(t){return 0!==t.size});if(0===n.length)return t;if(1===n.length){var s=n[0];if(s===t||r&&o(s)||a(t)&&a(s))return s}var f=new z(n);return r?f=f.toKeyedSeq():a(t)||(f=f.toSetSeq()),f=f.flatten(!0),f.size=n.reduce(function(t,e){if(void 0!==t){var u=e.size;if(void 0!==u)return t+u}},0),f}function ve(t,e,u){var r=be(t);return r.__iterateUncached=function(r,n){function o(t,f){var c=this;t.__iterate(function(t,n){return(!e||f<e)&&i(t)?o(t,f+1):!1===r(t,u?n:a++,c)&&(s=!0),!s},n)}var a=0,s=!1;return o(t,0),a},r.__iteratorUncached=function(r,n){var o=t.__iterator(r,n),a=[],s=0;return new A(function(){for(;o;){var t=o.next();if(!1===t.done){var f=t.value;if(r===Cu&&(f=f[1]),e&&!(a.length<e)||!i(f))return u?t:y(r,s++,f,t);a.push(o),o=f.__iterator(r,n)}else o=a.pop()}return B()})},r}function Fe(t,e,u){var r=we(t);return t.toSeq().map(function(n,i){return r(e.call(u,n,i,t))}).flatten(!0)}function Ee(t,e){var u=be(t);return u.size=t.size&&2*t.size-1,u.__iterateUncached=function(u,r){var n=this,i=0;return t.__iterate(function(t,r){return(!i||!1!==u(e,i++,n))&&!1!==u(t,i++,n)},r),i},u.__iteratorUncached=function(u,r){var n,i=t.__iterator(Eu,r),o=0;return new A(function(){return(!n||o%2)&&(n=i.next()).done?n:o%2?y(u,o++,e):y(u,o++,n.value,n)})},u}function Ce(t,e,u){e||(e=xe);var r=o(t),n=0,i=t.toSeq().map(function(e,r){return[r,e,n++,u?u(e,r,t):e]}).toArray();return i.sort(function(t,u){return e(t[3],u[3])||t[2]-u[2]}).forEach(r?function(t,e){i[e].length=2}:function(t,e){i[e]=t[1]}),r?x(i):a(t)?L(i):O(i)}function Ae(t,e,u){if(e||(e=xe),u){var r=t.toSeq().map(function(e,r){return[e,u(e,r,t)]}).reduce(function(t,u){return ye(e,t[1],u[1])?u:t});return r&&r[0]}return t.reduce(function(t,u){return ye(e,t,u)?u:t})}function ye(t,e,u){var r=t(u,e);return 0===r&&u!==e&&(void 0===u||null===u||u!==u)||r>0}function Be(t,u,r){var n=be(t);return n.size=new z(r).map(function(t){return t.size}).min(),n.__iterate=function(t,e){for(var u,r=this.__iterator(Eu,e),n=0;!(u=r.next()).done&&!1!==t(u.value,n++,this););return n},n.__iteratorUncached=function(t,n){var i=r.map(function(t){return t=e(t),S(n?t.reverse():t)}),o=0,a=!1;return new A(function(){var e;return a||(e=i.map(function(t){return t.next()}),a=e.some(function(t){return t.done})),a?B():y(t,o++,u.apply(null,e.map(function(t){return t.value})))})},n}function ge(t,e){return j(t)?e:t.constructor(e)}function me(t){if(t!==Object(t))throw new TypeError("Expected [K, V] tuple: "+t)}function Se(t){return ct(t.size),p(t)}function we(t){return o(t)?u:a(t)?r:n}function be(t){return Object.create((o(t)?x:a(t)?L:O).prototype)}function Ie(){return this._iter.cacheResult?(this._iter.cacheResult(),this.size=this._iter.size,this):I.prototype.cacheResult.call(this)}function xe(t,e){return t>e?1:t<e?-1:0}function Le(t){var u=S(t);if(!u){if(!b(t))throw new TypeError("Expected iterable or array-like: "+t);u=S(e(t))}return u}function Oe(t,e){var u,r=function(i){if(i instanceof r)return i;if(!(this instanceof r))return new r(i);if(!u){u=!0;var o=Object.keys(t);Re(n,o),n.size=o.length,n._name=e,n._keys=o,n._defaultValues=t}this._map=Dt(i)},n=r.prototype=Object.create(Yu);return n.constructor=r,r}function ze(t,e,u){var r=Object.create(Object.getPrototypeOf(t));return r._map=e,r.__ownerID=u,r}function Me(t){return t._name||t.constructor.name||"Record"}function Re(t,e){try{e.forEach(ke.bind(void 0,t))}catch(t){}}function ke(t,e){Object.defineProperty(t,e,{get:function(){return this.get(e)},set:function(t){$(this.__ownerID,"Cannot set on an immutable record."),this.set(e,t)}})}function je(t){return null===t||void 0===t?Ne():Pe(t)&&!f(t)?t:Ne().withMutations(function(e){var u=n(t);ct(u.size),u.forEach(function(t){return e.add(t)})})}function Pe(t){return!(!t||!t[Qu])}function Te(t,e){return t.__ownerID?(t.size=e.size,t._map=e,t):e===t._map?t:0===e.size?t.__empty():t.__make(e)}function qe(t,e){var u=Object.create($u);return u.size=t?t.size:0,u._map=t,u.__ownerID=e,u}function Ne(){return Zu||(Zu=qe(yt()))}function Ue(t){return null===t||void 0===t?Je():We(t)?t:Je().withMutations(function(e){var u=n(t);ct(u.size),u.forEach(function(t){return e.add(t)})})}function We(t){return Pe(t)&&f(t)}function Ke(t,e){var u=Object.create(tr);return u.size=t?t.size:0,u._map=t,u.__ownerID=e,u}function Je(){return er||(er=Ke(ee()))}function He(t){return null===t||void 0===t?Ve():Xe(t)?t:Ve().unshiftAll(t)}function Xe(t){return!(!t||!t[ur])}function Ge(t,e,u,r){var n=Object.create(rr);return n.size=t,n._head=e,n.__ownerID=u,n.__hash=r,n.__altered=!1,n}function Ve(){return nr||(nr=Ge(0))}function Ye(t,e){var u=function(u){t.prototype[u]=e[u]};return Object.keys(e).forEach(u),Object.getOwnPropertySymbols&&Object.getOwnPropertySymbols(e).forEach(u),t}function Qe(t,e){return e}function $e(t,e){return[e,t]}function Ze(t){return function(){return!t.apply(this,arguments)}}function tu(t){return function(){return-t.apply(this,arguments)}}function eu(t){return"string"==typeof t?JSON.stringify(t):String(t)}function uu(){return h(arguments)}function ru(t,e){return t<e?1:t>e?-1:0}function nu(t){if(t.size===1/0)return 0;var e=f(t),u=o(t),r=e?1:0;return iu(t.__iterate(u?e?function(t,e){r=31*r+ou(it(t),it(e))|0}:function(t,e){r=r+ou(it(t),it(e))|0}:e?function(t){r=31*r+it(t)|0}:function(t){r=r+it(t)|0}),r)}function iu(t,e){return e=Iu(e,3432918353),e=Iu(e<<15|e>>>-15,461845907),e=Iu(e<<13|e>>>-13,5),e=(e+3864292196|0)^t,e=Iu(e^e>>>16,2246822507),e=Iu(e^e>>>13,3266489909),e=nt(e^e>>>16)}function ou(t,e){return t^e+2654435769+(t<<6)+(t>>2)|0}var au=Array.prototype.slice;t(u,e),t(r,e),t(n,e),e.isIterable=i,e.isKeyed=o,e.isIndexed=a,e.isAssociative=s,e.isOrdered=f,e.Keyed=u,e.Indexed=r,e.Set=n;var su="@@__IMMUTABLE_ITERABLE__@@",fu="@@__IMMUTABLE_KEYED__@@",cu="@@__IMMUTABLE_INDEXED__@@",Du="@@__IMMUTABLE_ORDERED__@@",lu=5,hu=1<<lu,pu=hu-1,du={},_u={value:!1},vu={value:!1},Fu=0,Eu=1,Cu=2,Au="function"==typeof Symbol&&Symbol.iterator,yu="@@iterator",Bu=Au||yu;A.prototype.toString=function(){return"[Iterator]"},A.KEYS=Fu,A.VALUES=Eu,A.ENTRIES=Cu,A.prototype.inspect=A.prototype.toSource=function(){return this.toString()},A.prototype[Bu]=function(){return this},t(I,e),I.of=function(){return I(arguments)},I.prototype.toSeq=function(){return this},I.prototype.toString=function(){return this.__toString("Seq {","}")},I.prototype.cacheResult=function(){return!this._cache&&this.__iterateUncached&&(this._cache=this.entrySeq().toArray(),this.size=this._cache.length),this},I.prototype.__iterate=function(t,e){return W(this,t,e,!0)},I.prototype.__iterator=function(t,e){return K(this,t,e,!0)},t(x,I),x.prototype.toKeyedSeq=function(){return this},t(L,I),L.of=function(){return L(arguments)},L.prototype.toIndexedSeq=function(){return this},L.prototype.toString=function(){return this.__toString("Seq [","]")},L.prototype.__iterate=function(t,e){return W(this,t,e,!1)},L.prototype.__iterator=function(t,e){return K(this,t,e,!1)},t(O,I),O.of=function(){return O(arguments)},O.prototype.toSetSeq=function(){return this},I.isSeq=j,I.Keyed=x,I.Set=O,I.Indexed=L;var gu="@@__IMMUTABLE_SEQ__@@";I.prototype[gu]=!0,t(z,L),z.prototype.get=function(t,e){return this.has(t)?this._array[d(this,t)]:e},z.prototype.__iterate=function(t,e){for(var u=this._array,r=u.length-1,n=0;n<=r;n++)if(!1===t(u[e?r-n:n],n,this))return n+1;return n},z.prototype.__iterator=function(t,e){var u=this._array,r=u.length-1,n=0;return new A(function(){return n>r?B():y(t,n,u[e?r-n++:n++])})},t(M,x),M.prototype.get=function(t,e){return void 0===e||this.has(t)?this._object[t]:e},M.prototype.has=function(t){return this._object.hasOwnProperty(t)},M.prototype.__iterate=function(t,e){for(var u=this._object,r=this._keys,n=r.length-1,i=0;i<=n;i++){var o=r[e?n-i:i];if(!1===t(u[o],o,this))return i+1}return i},M.prototype.__iterator=function(t,e){var u=this._object,r=this._keys,n=r.length-1,i=0;return new A(function(){var o=r[e?n-i:i];return i++>n?B():y(t,o,u[o])})},M.prototype[Du]=!0,t(R,L),R.prototype.__iterateUncached=function(t,e){if(e)return this.cacheResult().__iterate(t,e);var u=S(this._iterable),r=0;if(m(u))for(var n;!(n=u.next()).done&&!1!==t(n.value,r++,this););return r},R.prototype.__iteratorUncached=function(t,e){if(e)return this.cacheResult().__iterator(t,e);var u=S(this._iterable);if(!m(u))return new A(B);var r=0;return new A(function(){var e=u.next();return e.done?e:y(t,r++,e.value)})},t(k,L),k.prototype.__iterateUncached=function(t,e){if(e)return this.cacheResult().__iterate(t,e);for(var u=this._iterator,r=this._iteratorCache,n=0;n<r.length;)if(!1===t(r[n],n++,this))return n;for(var i;!(i=u.next()).done;){var o=i.value;if(r[n]=o,!1===t(o,n++,this))break}return n},k.prototype.__iteratorUncached=function(t,e){if(e)return this.cacheResult().__iterator(t,e);var u=this._iterator,r=this._iteratorCache,n=0;return new A(function(){if(n>=r.length){var e=u.next();if(e.done)return e;r[n]=e.value}return y(t,n,r[n++])})};var mu;t(Q,L),Q.prototype.toString=function(){return 0===this.size?"Repeat []":"Repeat [ "+this._value+" "+this.size+" times ]"},Q.prototype.get=function(t,e){return this.has(t)?this._value:e},Q.prototype.includes=function(t){return V(this._value,t)},Q.prototype.slice=function(t,e){var u=this.size;return v(t,e,u)?this:new Q(this._value,E(e,u)-F(t,u))},Q.prototype.reverse=function(){return this},Q.prototype.indexOf=function(t){return V(this._value,t)?0:-1},Q.prototype.lastIndexOf=function(t){return V(this._value,t)?this.size:-1},Q.prototype.__iterate=function(t,e){for(var u=0;u<this.size;u++)if(!1===t(this._value,u,this))return u+1;return u},Q.prototype.__iterator=function(t,e){var u=this,r=0;return new A(function(){return r<u.size?y(t,r++,u._value):B()})},Q.prototype.equals=function(t){return t instanceof Q?V(this._value,t._value):Y(t)};var Su;t(Z,L),Z.prototype.toString=function(){return 0===this.size?"Range []":"Range [ "+this._start+"..."+this._end+(1!==this._step?" by "+this._step:"")+" ]"},Z.prototype.get=function(t,e){return this.has(t)?this._start+d(this,t)*this._step:e},Z.prototype.includes=function(t){var e=(t-this._start)/this._step;return e>=0&&e<this.size&&e===Math.floor(e)},Z.prototype.slice=function(t,e){return v(t,e,this.size)?this:(t=F(t,this.size),(e=E(e,this.size))<=t?new Z(0,0):new Z(this.get(t,this._end),this.get(e,this._end),this._step))},Z.prototype.indexOf=function(t){var e=t-this._start;if(e%this._step==0){var u=e/this._step;if(u>=0&&u<this.size)return u}return-1},Z.prototype.lastIndexOf=function(t){return this.indexOf(t)},Z.prototype.__iterate=function(t,e){for(var u=this.size-1,r=this._step,n=e?this._start+u*r:this._start,i=0;i<=u;i++){if(!1===t(n,i,this))return i+1;n+=e?-r:r}return i},Z.prototype.__iterator=function(t,e){var u=this.size-1,r=this._step,n=e?this._start+u*r:this._start,i=0;return new A(function(){var o=n;return n+=e?-r:r,i>u?B():y(t,i++,o)})},Z.prototype.equals=function(t){return t instanceof Z?this._start===t._start&&this._end===t._end&&this._step===t._step:Y(this,t)};var wu;t(tt,e),t(et,tt),t(ut,tt),t(rt,tt),tt.Keyed=et,tt.Indexed=ut,tt.Set=rt;var bu,Iu="function"==typeof Math.imul&&-2===Math.imul(4294967295,2)?Math.imul:function(t,e){var u=65535&(t|=0),r=65535&(e|=0);return u*r+((t>>>16)*r+u*(e>>>16)<<16>>>0)|0},xu=Object.isExtensible,Lu=function(){try{return Object.defineProperty({},"@",{}),!0}catch(t){return!1}}(),Ou="function"==typeof WeakMap;Ou&&(bu=new WeakMap);var zu=0,Mu="__immutablehash__";"function"==typeof Symbol&&(Mu=Symbol(Mu));var Ru=16,ku=255,ju=0,Pu={};t(Dt,et),Dt.of=function(){var t=au.call(arguments,0);return yt().withMutations(function(e){for(var u=0;u<t.length;u+=2){if(u+1>=t.length)throw new Error("Missing value for key: "+t[u]);e.set(t[u],t[u+1])}})},Dt.prototype.toString=function(){return this.__toString("Map {","}")},Dt.prototype.get=function(t,e){return this._root?this._root.get(0,void 0,t,e):e},Dt.prototype.set=function(t,e){return Bt(this,t,e)},Dt.prototype.setIn=function(t,e){return this.updateIn(t,du,function(){return e})},Dt.prototype.remove=function(t){return Bt(this,t,du)},Dt.prototype.deleteIn=function(t){return this.updateIn(t,function(){return du})},Dt.prototype.update=function(t,e,u){return 1===arguments.length?t(this):this.updateIn([t],e,u)},Dt.prototype.updateIn=function(t,e,u){u||(u=e,e=void 0);var r=Mt(this,Le(t),e,u);return r===du?void 0:r},Dt.prototype.clear=function(){return 0===this.size?this:this.__ownerID?(this.size=0,this._root=null,this.__hash=void 0,this.__altered=!0,this):yt()},Dt.prototype.merge=function(){return xt(this,void 0,arguments)},Dt.prototype.mergeWith=function(t){return xt(this,t,au.call(arguments,1))},Dt.prototype.mergeIn=function(t){var e=au.call(arguments,1);return this.updateIn(t,yt(),function(t){return"function"==typeof t.merge?t.merge.apply(t,e):e[e.length-1]})},Dt.prototype.mergeDeep=function(){return xt(this,Lt,arguments)},Dt.prototype.mergeDeepWith=function(t){var e=au.call(arguments,1);return xt(this,Ot(t),e)},Dt.prototype.mergeDeepIn=function(t){var e=au.call(arguments,1);return this.updateIn(t,yt(),function(t){return"function"==typeof t.mergeDeep?t.mergeDeep.apply(t,e):e[e.length-1]})},Dt.prototype.sort=function(t){return $t(Ce(this,t))},Dt.prototype.sortBy=function(t,e){return $t(Ce(this,e,t))},Dt.prototype.withMutations=function(t){var e=this.asMutable();return t(e),e.wasAltered()?e.__ensureOwner(this.__ownerID):this},Dt.prototype.asMutable=function(){return this.__ownerID?this:this.__ensureOwner(new l)},Dt.prototype.asImmutable=function(){return this.__ensureOwner()},Dt.prototype.wasAltered=function(){return this.__altered},Dt.prototype.__iterator=function(t,e){return new Ft(this,t,e)},Dt.prototype.__iterate=function(t,e){var u=this,r=0;return this._root&&this._root.iterate(function(e){return r++,t(e[1],e[0],u)},e),r},Dt.prototype.__ensureOwner=function(t){return t===this.__ownerID?this:t?At(this.size,this._root,t,this.__hash):(this.__ownerID=t,this.__altered=!1,this)},Dt.isMap=lt;var Tu="@@__IMMUTABLE_MAP__@@",qu=Dt.prototype;qu[Tu]=!0,qu.delete=qu.remove,qu.removeIn=qu.deleteIn,ht.prototype.get=function(t,e,u,r){for(var n=this.entries,i=0,o=n.length;i<o;i++)if(V(u,n[i][0]))return n[i][1];return r},ht.prototype.update=function(t,e,u,r,n,i,o){for(var a=n===du,s=this.entries,f=0,c=s.length;f<c&&!V(r,s[f][0]);f++);var l=f<c;if(l?s[f][1]===n:a)return this;if(D(o),(a||!l)&&D(i),!a||1!==s.length){if(!l&&!a&&s.length>=Uu)return wt(t,s,r,n);var p=t&&t===this.ownerID,d=p?s:h(s);return l?a?f===c-1?d.pop():d[f]=d.pop():d[f]=[r,n]:d.push([r,n]),p?(this.entries=d,this):new ht(t,d)}},pt.prototype.get=function(t,e,u,r){void 0===e&&(e=it(u));var n=1<<((0===t?e:e>>>t)&pu),i=this.bitmap;return 0==(i&n)?r:this.nodes[Rt(i&n-1)].get(t+lu,e,u,r)},pt.prototype.update=function(t,e,u,r,n,i,o){void 0===u&&(u=it(r));var a=(0===e?u:u>>>e)&pu,s=1<<a,f=this.bitmap,c=0!=(f&s);if(!c&&n===du)return this;var D=Rt(f&s-1),l=this.nodes,h=c?l[D]:void 0,p=gt(h,t,e+lu,u,r,n,i,o);if(p===h)return this;if(!c&&p&&l.length>=Wu)return It(t,l,f,a,p);if(c&&!p&&2===l.length&&mt(l[1^D]))return l[1^D];if(c&&p&&1===l.length&&mt(p))return p;var d=t&&t===this.ownerID,_=c?p?f:f^s:f|s,v=c?p?kt(l,D,p,d):Pt(l,D,d):jt(l,D,p,d);return d?(this.bitmap=_,this.nodes=v,this):new pt(t,_,v)},dt.prototype.get=function(t,e,u,r){void 0===e&&(e=it(u));var n=(0===t?e:e>>>t)&pu,i=this.nodes[n];return i?i.get(t+lu,e,u,r):r},dt.prototype.update=function(t,e,u,r,n,i,o){void 0===u&&(u=it(r));var a=(0===e?u:u>>>e)&pu,s=n===du,f=this.nodes,c=f[a];if(s&&!c)return this;var D=gt(c,t,e+lu,u,r,n,i,o);if(D===c)return this;var l=this.count;if(c){if(!D&&--l<Ku)return bt(t,f,l,a)}else l++;var h=t&&t===this.ownerID,p=kt(f,a,D,h);return h?(this.count=l,this.nodes=p,this):new dt(t,l,p)},_t.prototype.get=function(t,e,u,r){for(var n=this.entries,i=0,o=n.length;i<o;i++)if(V(u,n[i][0]))return n[i][1];return r},_t.prototype.update=function(t,e,u,r,n,i,o){void 0===u&&(u=it(r));var a=n===du;if(u!==this.keyHash)return a?this:(D(o),D(i),St(this,t,e,u,[r,n]));for(var s=this.entries,f=0,c=s.length;f<c&&!V(r,s[f][0]);f++);var l=f<c;if(l?s[f][1]===n:a)return this;if(D(o),(a||!l)&&D(i),a&&2===c)return new vt(t,this.keyHash,s[1^f]);var p=t&&t===this.ownerID,d=p?s:h(s);return l?a?f===c-1?d.pop():d[f]=d.pop():d[f]=[r,n]:d.push([r,n]),p?(this.entries=d,this):new _t(t,this.keyHash,d)},vt.prototype.get=function(t,e,u,r){return V(u,this.entry[0])?this.entry[1]:r},vt.prototype.update=function(t,e,u,r,n,i,o){var a=n===du,s=V(r,this.entry[0]);return(s?n===this.entry[1]:a)?this:(D(o),a?void D(i):s?t&&t===this.ownerID?(this.entry[1]=n,this):new vt(t,this.keyHash,[r,n]):(D(i),St(this,t,e,it(r),[r,n])))},ht.prototype.iterate=_t.prototype.iterate=function(t,e){for(var u=this.entries,r=0,n=u.length-1;r<=n;r++)if(!1===t(u[e?n-r:r]))return!1},pt.prototype.iterate=dt.prototype.iterate=function(t,e){for(var u=this.nodes,r=0,n=u.length-1;r<=n;r++){var i=u[e?n-r:r];if(i&&!1===i.iterate(t,e))return!1}},vt.prototype.iterate=function(t,e){return t(this.entry)},t(Ft,A),Ft.prototype.next=function(){for(var t=this._type,e=this._stack;e;){var u,r=e.node,n=e.index++;if(r.entry){if(0===n)return Et(t,r.entry)}else if(r.entries){if(u=r.entries.length-1,n<=u)return Et(t,r.entries[this._reverse?u-n:n])}else if(u=r.nodes.length-1,n<=u){var i=r.nodes[this._reverse?u-n:n];if(i){if(i.entry)return Et(t,i.entry);e=this._stack=Ct(i,e)}continue}e=this._stack=this._stack.__prev}return B()};var Nu,Uu=hu/4,Wu=hu/2,Ku=hu/4;t(Tt,ut),Tt.of=function(){return this(arguments)},Tt.prototype.toString=function(){return this.__toString("List [","]")},Tt.prototype.get=function(t,e){if((t=d(this,t))>=0&&t<this.size){var u=Gt(this,t+=this._origin);return u&&u.array[t&pu]}return e},Tt.prototype.set=function(t,e){return Jt(this,t,e)},Tt.prototype.remove=function(t){return this.has(t)?0===t?this.shift():t===this.size-1?this.pop():this.splice(t,1):this},Tt.prototype.insert=function(t,e){return this.splice(t,0,e)},Tt.prototype.clear=function(){return 0===this.size?this:this.__ownerID?(this.size=this._origin=this._capacity=0,this._level=lu,this._root=this._tail=null,this.__hash=void 0,this.__altered=!0,this):Kt()},Tt.prototype.push=function(){var t=arguments,e=this.size;return this.withMutations(function(u){Vt(u,0,e+t.length);for(var r=0;r<t.length;r++)u.set(e+r,t[r])})},Tt.prototype.pop=function(){return Vt(this,0,-1)},Tt.prototype.unshift=function(){var t=arguments;return this.withMutations(function(e){Vt(e,-t.length);for(var u=0;u<t.length;u++)e.set(u,t[u])})},Tt.prototype.shift=function(){return Vt(this,1)},Tt.prototype.merge=function(){return Yt(this,void 0,arguments)},Tt.prototype.mergeWith=function(t){return Yt(this,t,au.call(arguments,1))},Tt.prototype.mergeDeep=function(){return Yt(this,Lt,arguments)},Tt.prototype.mergeDeepWith=function(t){var e=au.call(arguments,1);return Yt(this,Ot(t),e)},Tt.prototype.setSize=function(t){return Vt(this,0,t)},Tt.prototype.slice=function(t,e){var u=this.size;return v(t,e,u)?this:Vt(this,F(t,u),E(e,u))},Tt.prototype.__iterator=function(t,e){var u=0,r=Ut(this,e);return new A(function(){var e=r();return e===Gu?B():y(t,u++,e)})},Tt.prototype.__iterate=function(t,e){for(var u,r=0,n=Ut(this,e);(u=n())!==Gu&&!1!==t(u,r++,this););return r},Tt.prototype.__ensureOwner=function(t){return t===this.__ownerID?this:t?Wt(this._origin,this._capacity,this._level,this._root,this._tail,t,this.__hash):(this.__ownerID=t,this)},Tt.isList=qt;var Ju="@@__IMMUTABLE_LIST__@@",Hu=Tt.prototype;Hu[Ju]=!0,Hu.delete=Hu.remove,Hu.setIn=qu.setIn,Hu.deleteIn=Hu.removeIn=qu.removeIn,Hu.update=qu.update,Hu.updateIn=qu.updateIn,Hu.mergeIn=qu.mergeIn,Hu.mergeDeepIn=qu.mergeDeepIn,Hu.withMutations=qu.withMutations,Hu.asMutable=qu.asMutable,Hu.asImmutable=qu.asImmutable,Hu.wasAltered=qu.wasAltered,Nt.prototype.removeBefore=function(t,e,u){if(u===e?1<<e:0===this.array.length)return this;var r=u>>>e&pu;if(r>=this.array.length)return new Nt([],t);var n,i=0===r;if(e>0){var o=this.array[r];if((n=o&&o.removeBefore(t,e-lu,u))===o&&i)return this}if(i&&!n)return this;var a=Xt(this,t);if(!i)for(var s=0;s<r;s++)a.array[s]=void 0;return n&&(a.array[r]=n),a},Nt.prototype.removeAfter=function(t,e,u){if(u===(e?1<<e:0)||0===this.array.length)return this;var r=u-1>>>e&pu;if(r>=this.array.length)return this;var n;if(e>0){var i=this.array[r];if((n=i&&i.removeAfter(t,e-lu,u))===i&&r===this.array.length-1)return this}var o=Xt(this,t);return o.array.splice(r+1),n&&(o.array[r]=n),o};var Xu,Gu={};t($t,Dt),$t.of=function(){return this(arguments)},$t.prototype.toString=function(){return this.__toString("OrderedMap {","}")},$t.prototype.get=function(t,e){var u=this._map.get(t);return void 0!==u?this._list.get(u)[1]:e},$t.prototype.clear=function(){return 0===this.size?this:this.__ownerID?(this.size=0,this._map.clear(),this._list.clear(),this):ee()},$t.prototype.set=function(t,e){return ue(this,t,e)},$t.prototype.remove=function(t){return ue(this,t,du)},$t.prototype.wasAltered=function(){return this._map.wasAltered()||this._list.wasAltered()},$t.prototype.__iterate=function(t,e){var u=this;return this._list.__iterate(function(e){return e&&t(e[1],e[0],u)},e)},$t.prototype.__iterator=function(t,e){return this._list.fromEntrySeq().__iterator(t,e)},$t.prototype.__ensureOwner=function(t){if(t===this.__ownerID)return this;var e=this._map.__ensureOwner(t),u=this._list.__ensureOwner(t);return t?te(e,u,t,this.__hash):(this.__ownerID=t,this._map=e,this._list=u,this)},$t.isOrderedMap=Zt,$t.prototype[Du]=!0,$t.prototype.delete=$t.prototype.remove;var Vu;t(re,x),re.prototype.get=function(t,e){return this._iter.get(t,e)},re.prototype.has=function(t){return this._iter.has(t)},re.prototype.valueSeq=function(){return this._iter.valueSeq()},re.prototype.reverse=function(){var t=this,e=fe(this,!0);return this._useKeys||(e.valueSeq=function(){return t._iter.toSeq().reverse()}),e},re.prototype.map=function(t,e){var u=this,r=se(this,t,e);return this._useKeys||(r.valueSeq=function(){return u._iter.toSeq().map(t,e)}),r},re.prototype.__iterate=function(t,e){var u,r=this;return this._iter.__iterate(this._useKeys?function(e,u){return t(e,u,r)}:(u=e?Se(this):0,function(n){return t(n,e?--u:u++,r)}),e)},re.prototype.__iterator=function(t,e){if(this._useKeys)return this._iter.__iterator(t,e);var u=this._iter.__iterator(Eu,e),r=e?Se(this):0;return new A(function(){var n=u.next();return n.done?n:y(t,e?--r:r++,n.value,n)})},re.prototype[Du]=!0,t(ne,L),ne.prototype.includes=function(t){return this._iter.includes(t)},ne.prototype.__iterate=function(t,e){var u=this,r=0;return this._iter.__iterate(function(e){return t(e,r++,u)},e)},ne.prototype.__iterator=function(t,e){var u=this._iter.__iterator(Eu,e),r=0;return new A(function(){var e=u.next();return e.done?e:y(t,r++,e.value,e)})},t(ie,O),ie.prototype.has=function(t){return this._iter.includes(t)},ie.prototype.__iterate=function(t,e){var u=this;return this._iter.__iterate(function(e){return t(e,e,u)},e)},ie.prototype.__iterator=function(t,e){var u=this._iter.__iterator(Eu,e);return new A(function(){var e=u.next();return e.done?e:y(t,e.value,e.value,e)})},t(oe,x),oe.prototype.entrySeq=function(){return this._iter.toSeq()},oe.prototype.__iterate=function(t,e){var u=this;return this._iter.__iterate(function(e){if(e){me(e);var r=i(e);return t(r?e.get(1):e[1],r?e.get(0):e[0],u)}},e)},oe.prototype.__iterator=function(t,e){var u=this._iter.__iterator(Eu,e);return new A(function(){for(;;){var e=u.next();if(e.done)return e;var r=e.value;if(r){me(r);var n=i(r);return y(t,n?r.get(0):r[0],n?r.get(1):r[1],e)}}})},ne.prototype.cacheResult=re.prototype.cacheResult=ie.prototype.cacheResult=oe.prototype.cacheResult=Ie,t(Oe,et),Oe.prototype.toString=function(){return this.__toString(Me(this)+" {","}")},Oe.prototype.has=function(t){return this._defaultValues.hasOwnProperty(t)},Oe.prototype.get=function(t,e){if(!this.has(t))return e;var u=this._defaultValues[t];return this._map?this._map.get(t,u):u},Oe.prototype.clear=function(){if(this.__ownerID)return this._map&&this._map.clear(),this;var t=this.constructor;return t._empty||(t._empty=ze(this,yt()))},Oe.prototype.set=function(t,e){if(!this.has(t))throw new Error('Cannot set unknown key "'+t+'" on '+Me(this));if(this._map&&!this._map.has(t)&&e===this._defaultValues[t])return this;var u=this._map&&this._map.set(t,e);return this.__ownerID||u===this._map?this:ze(this,u)},Oe.prototype.remove=function(t){if(!this.has(t))return this;var e=this._map&&this._map.remove(t);return this.__ownerID||e===this._map?this:ze(this,e)},Oe.prototype.wasAltered=function(){return this._map.wasAltered()},Oe.prototype.__iterator=function(t,e){var r=this;return u(this._defaultValues).map(function(t,e){return r.get(e)}).__iterator(t,e)},Oe.prototype.__iterate=function(t,e){var r=this;return u(this._defaultValues).map(function(t,e){return r.get(e)}).__iterate(t,e)},Oe.prototype.__ensureOwner=function(t){if(t===this.__ownerID)return this;var e=this._map&&this._map.__ensureOwner(t);return t?ze(this,e,t):(this.__ownerID=t,this._map=e,this)};var Yu=Oe.prototype;Yu.delete=Yu.remove,Yu.deleteIn=Yu.removeIn=qu.removeIn,Yu.merge=qu.merge,Yu.mergeWith=qu.mergeWith,Yu.mergeIn=qu.mergeIn,Yu.mergeDeep=qu.mergeDeep,Yu.mergeDeepWith=qu.mergeDeepWith,Yu.mergeDeepIn=qu.mergeDeepIn,Yu.setIn=qu.setIn,Yu.update=qu.update,Yu.updateIn=qu.updateIn,Yu.withMutations=qu.withMutations,Yu.asMutable=qu.asMutable,Yu.asImmutable=qu.asImmutable,t(je,rt),je.of=function(){return this(arguments)},je.fromKeys=function(t){return this(u(t).keySeq())},je.prototype.toString=function(){return this.__toString("Set {","}")},je.prototype.has=function(t){return this._map.has(t)},je.prototype.add=function(t){return Te(this,this._map.set(t,!0))},je.prototype.remove=function(t){return Te(this,this._map.remove(t))},je.prototype.clear=function(){return Te(this,this._map.clear())},je.prototype.union=function(){var t=au.call(arguments,0);return 0===(t=t.filter(function(t){return 0!==t.size})).length?this:0!==this.size||this.__ownerID||1!==t.length?this.withMutations(function(e){for(var u=0;u<t.length;u++)n(t[u]).forEach(function(t){return e.add(t)})}):this.constructor(t[0])},je.prototype.intersect=function(){var t=au.call(arguments,0);if(0===t.length)return this;t=t.map(function(t){return n(t)});var e=this;return this.withMutations(function(u){e.forEach(function(e){t.every(function(t){return t.includes(e)})||u.remove(e)})})},je.prototype.subtract=function(){var t=au.call(arguments,0);if(0===t.length)return this;t=t.map(function(t){return n(t)});var e=this;return this.withMutations(function(u){e.forEach(function(e){t.some(function(t){return t.includes(e)})&&u.remove(e)})})},je.prototype.merge=function(){return this.union.apply(this,arguments)},je.prototype.mergeWith=function(t){var e=au.call(arguments,1);return this.union.apply(this,e)},je.prototype.sort=function(t){return Ue(Ce(this,t))},je.prototype.sortBy=function(t,e){return Ue(Ce(this,e,t))},je.prototype.wasAltered=function(){return this._map.wasAltered()},je.prototype.__iterate=function(t,e){var u=this;return this._map.__iterate(function(e,r){return t(r,r,u)},e)},je.prototype.__iterator=function(t,e){return this._map.map(function(t,e){return e}).__iterator(t,e)},je.prototype.__ensureOwner=function(t){if(t===this.__ownerID)return this;var e=this._map.__ensureOwner(t);return t?this.__make(e,t):(this.__ownerID=t,this._map=e,this)},je.isSet=Pe;var Qu="@@__IMMUTABLE_SET__@@",$u=je.prototype;$u[Qu]=!0,$u.delete=$u.remove,$u.mergeDeep=$u.merge,$u.mergeDeepWith=$u.mergeWith,$u.withMutations=qu.withMutations,$u.asMutable=qu.asMutable,$u.asImmutable=qu.asImmutable,$u.__empty=Ne,$u.__make=qe;var Zu;t(Ue,je),Ue.of=function(){return this(arguments)},Ue.fromKeys=function(t){return this(u(t).keySeq())},Ue.prototype.toString=function(){return this.__toString("OrderedSet {","}")},Ue.isOrderedSet=We;var tr=Ue.prototype;tr[Du]=!0,tr.__empty=Je,tr.__make=Ke;var er;t(He,ut),He.of=function(){return this(arguments)},He.prototype.toString=function(){return this.__toString("Stack [","]")},He.prototype.get=function(t,e){var u=this._head;for(t=d(this,t);u&&t--;)u=u.next;return u?u.value:e},He.prototype.peek=function(){return this._head&&this._head.value},He.prototype.push=function(){if(0===arguments.length)return this;for(var t=this.size+arguments.length,e=this._head,u=arguments.length-1;u>=0;u--)e={value:arguments[u],next:e};return this.__ownerID?(this.size=t,this._head=e,this.__hash=void 0,this.__altered=!0,this):Ge(t,e)},He.prototype.pushAll=function(t){if(0===(t=r(t)).size)return this;ct(t.size);var e=this.size,u=this._head;return t.reverse().forEach(function(t){e++,u={value:t,next:u}}),this.__ownerID?(this.size=e,this._head=u,this.__hash=void 0,this.__altered=!0,this):Ge(e,u)},He.prototype.pop=function(){return this.slice(1)},He.prototype.unshift=function(){return this.push.apply(this,arguments)},He.prototype.unshiftAll=function(t){return this.pushAll(t)},He.prototype.shift=function(){return this.pop.apply(this,arguments)},He.prototype.clear=function(){return 0===this.size?this:this.__ownerID?(this.size=0,this._head=void 0,this.__hash=void 0,this.__altered=!0,this):Ve()},He.prototype.slice=function(t,e){if(v(t,e,this.size))return this;var u=F(t,this.size);if(E(e,this.size)!==this.size)return ut.prototype.slice.call(this,t,e);for(var r=this.size-u,n=this._head;u--;)n=n.next;return this.__ownerID?(this.size=r,this._head=n,this.__hash=void 0,this.__altered=!0,this):Ge(r,n)},He.prototype.__ensureOwner=function(t){return t===this.__ownerID?this:t?Ge(this.size,this._head,t,this.__hash):(this.__ownerID=t,this.__altered=!1,this)},He.prototype.__iterate=function(t,e){if(e)return this.reverse().__iterate(t);for(var u=0,r=this._head;r&&!1!==t(r.value,u++,this);)r=r.next;return u},He.prototype.__iterator=function(t,e){if(e)return this.reverse().__iterator(t);var u=0,r=this._head;return new A(function(){if(r){var e=r.value;return r=r.next,y(t,u++,e)}return B()})},He.isStack=Xe;var ur="@@__IMMUTABLE_STACK__@@",rr=He.prototype;rr[ur]=!0,rr.withMutations=qu.withMutations,rr.asMutable=qu.asMutable,rr.asImmutable=qu.asImmutable,rr.wasAltered=qu.wasAltered;var nr;e.Iterator=A,Ye(e,{toArray:function(){ct(this.size);var t=new Array(this.size||0);return this.valueSeq().__iterate(function(e,u){t[u]=e}),t},toIndexedSeq:function(){return new ne(this)},toJS:function(){return this.toSeq().map(function(t){return t&&"function"==typeof t.toJS?t.toJS():t}).__toJS()},toJSON:function(){return this.toSeq().map(function(t){return t&&"function"==typeof t.toJSON?t.toJSON():t}).__toJS()},toKeyedSeq:function(){return new re(this,!0)},toMap:function(){return Dt(this.toKeyedSeq())},toObject:function(){ct(this.size);var t={};return this.__iterate(function(e,u){t[u]=e}),t},toOrderedMap:function(){return $t(this.toKeyedSeq())},toOrderedSet:function(){return Ue(o(this)?this.valueSeq():this)},toSet:function(){return je(o(this)?this.valueSeq():this)},toSetSeq:function(){return new ie(this)},toSeq:function(){return a(this)?this.toIndexedSeq():o(this)?this.toKeyedSeq():this.toSetSeq()},toStack:function(){return He(o(this)?this.valueSeq():this)},toList:function(){return Tt(o(this)?this.valueSeq():this)},toString:function(){return"[Iterable]"},__toString:function(t,e){return 0===this.size?t+e:t+" "+this.toSeq().map(this.__toStringMapper).join(", ")+" "+e},concat:function(){return ge(this,_e(this,au.call(arguments,0)))},includes:function(t){return this.some(function(e){return V(e,t)})},entries:function(){return this.__iterator(Cu)},every:function(t,e){ct(this.size);var u=!0;return this.__iterate(function(r,n,i){if(!t.call(e,r,n,i))return u=!1,!1}),u},filter:function(t,e){return ge(this,ce(this,t,e,!0))},find:function(t,e,u){var r=this.findEntry(t,e);return r?r[1]:u},forEach:function(t,e){return ct(this.size),this.__iterate(e?t.bind(e):t)},join:function(t){ct(this.size),t=void 0!==t?""+t:",";var e="",u=!0;return this.__iterate(function(r){u?u=!1:e+=t,e+=null!==r&&void 0!==r?r.toString():""}),e},keys:function(){return this.__iterator(Fu)},map:function(t,e){return ge(this,se(this,t,e))},reduce:function(t,e,u){ct(this.size);var r,n;return arguments.length<2?n=!0:r=e,this.__iterate(function(e,i,o){n?(n=!1,r=e):r=t.call(u,r,e,i,o)}),r},reduceRight:function(t,e,u){var r=this.toKeyedSeq().reverse();return r.reduce.apply(r,arguments)},reverse:function(){return ge(this,fe(this,!0))},slice:function(t,e){return ge(this,he(this,t,e,!0))},some:function(t,e){return!this.every(Ze(t),e)},sort:function(t){return ge(this,Ce(this,t))},values:function(){return this.__iterator(Eu)},butLast:function(){return this.slice(0,-1)},isEmpty:function(){return void 0!==this.size?0===this.size:!this.some(function(){return!0})},count:function(t,e){return p(t?this.toSeq().filter(t,e):this)},countBy:function(t,e){return De(this,t,e)},equals:function(t){return Y(this,t)},entrySeq:function(){var t=this;if(t._cache)return new z(t._cache);var e=t.toSeq().map($e).toIndexedSeq();return e.fromEntrySeq=function(){return t.toSeq()},e},filterNot:function(t,e){return this.filter(Ze(t),e)},findEntry:function(t,e,u){var r=u;return this.__iterate(function(u,n,i){if(t.call(e,u,n,i))return r=[n,u],!1}),r},findKey:function(t,e){var u=this.findEntry(t,e);return u&&u[0]},findLast:function(t,e,u){return this.toKeyedSeq().reverse().find(t,e,u)},findLastEntry:function(t,e,u){return this.toKeyedSeq().reverse().findEntry(t,e,u)},findLastKey:function(t,e){return this.toKeyedSeq().reverse().findKey(t,e)},first:function(){return this.find(_)},flatMap:function(t,e){return ge(this,Fe(this,t,e))},flatten:function(t){return ge(this,ve(this,t,!0))},fromEntrySeq:function(){return new oe(this)},get:function(t,e){return this.find(function(e,u){return V(u,t)},void 0,e)},getIn:function(t,e){for(var u,r=this,n=Le(t);!(u=n.next()).done;){var i=u.value;if((r=r&&r.get?r.get(i,du):du)===du)return e}return r},groupBy:function(t,e){return le(this,t,e)},has:function(t){return this.get(t,du)!==du},hasIn:function(t){return this.getIn(t,du)!==du},isSubset:function(t){return t="function"==typeof t.includes?t:e(t),this.every(function(e){return t.includes(e)})},isSuperset:function(t){return(t="function"==typeof t.isSubset?t:e(t)).isSubset(this)},keyOf:function(t){return this.findKey(function(e){return V(e,t)})},keySeq:function(){return this.toSeq().map(Qe).toIndexedSeq()},last:function(){return this.toSeq().reverse().first()},lastKeyOf:function(t){return this.toKeyedSeq().reverse().keyOf(t)},max:function(t){return Ae(this,t)},maxBy:function(t,e){return Ae(this,e,t)},min:function(t){return Ae(this,t?tu(t):ru)},minBy:function(t,e){return Ae(this,e?tu(e):ru,t)},rest:function(){return this.slice(1)},skip:function(t){return this.slice(Math.max(0,t))},skipLast:function(t){return ge(this,this.toSeq().reverse().skip(t).reverse())},skipWhile:function(t,e){return ge(this,de(this,t,e,!0))},skipUntil:function(t,e){return this.skipWhile(Ze(t),e)},sortBy:function(t,e){return ge(this,Ce(this,e,t))},take:function(t){return this.slice(0,Math.max(0,t))},takeLast:function(t){return ge(this,this.toSeq().reverse().take(t).reverse())},takeWhile:function(t,e){return ge(this,pe(this,t,e))},takeUntil:function(t,e){return this.takeWhile(Ze(t),e)},valueSeq:function(){return this.toIndexedSeq()},hashCode:function(){return this.__hash||(this.__hash=nu(this))}});var ir=e.prototype;ir[su]=!0,ir[Bu]=ir.values,ir.__toJS=ir.toArray,ir.__toStringMapper=eu,ir.inspect=ir.toSource=function(){return this.toString()},ir.chain=ir.flatMap,ir.contains=ir.includes,Ye(u,{flip:function(){return ge(this,ae(this))},mapEntries:function(t,e){var u=this,r=0;return ge(this,this.toSeq().map(function(n,i){return t.call(e,[i,n],r++,u)}).fromEntrySeq())},mapKeys:function(t,e){var u=this;return ge(this,this.toSeq().flip().map(function(r,n){return t.call(e,r,n,u)}).flip())}});var or=u.prototype;return or[fu]=!0,or[Bu]=ir.entries,or.__toJS=ir.toObject,or.__toStringMapper=function(t,e){return JSON.stringify(e)+": "+eu(t)},Ye(r,{toKeyedSeq:function(){return new re(this,!1)},filter:function(t,e){return ge(this,ce(this,t,e,!1))},findIndex:function(t,e){var u=this.findEntry(t,e);return u?u[0]:-1},indexOf:function(t){var e=this.keyOf(t);return void 0===e?-1:e},lastIndexOf:function(t){var e=this.lastKeyOf(t);return void 0===e?-1:e},reverse:function(){return ge(this,fe(this,!1))},slice:function(t,e){return ge(this,he(this,t,e,!1))},splice:function(t,e){var u=arguments.length;if(e=Math.max(0|e,0),0===u||2===u&&!e)return this;t=F(t,t<0?this.count():this.size);var r=this.slice(0,t);return ge(this,1===u?r:r.concat(h(arguments,2),this.slice(t+e)))},findLastIndex:function(t,e){var u=this.findLastEntry(t,e);return u?u[0]:-1},first:function(){return this.get(0)},flatten:function(t){return ge(this,ve(this,t,!1))},get:function(t,e){return(t=d(this,t))<0||this.size===1/0||void 0!==this.size&&t>this.size?e:this.find(function(e,u){return u===t},void 0,e)},has:function(t){return(t=d(this,t))>=0&&(void 0!==this.size?this.size===1/0||t<this.size:-1!==this.indexOf(t))},interpose:function(t){return ge(this,Ee(this,t))},interleave:function(){var t=[this].concat(h(arguments)),e=Be(this.toSeq(),L.of,t),u=e.flatten(!0);return e.size&&(u.size=e.size*t.length),ge(this,u)},keySeq:function(){return Z(0,this.size)},last:function(){return this.get(-1)},skipWhile:function(t,e){return ge(this,de(this,t,e,!1))},zip:function(){return ge(this,Be(this,uu,[this].concat(h(arguments))))},zipWith:function(t){var e=h(arguments);return e[0]=this,ge(this,Be(this,t,e))}}),r.prototype[cu]=!0,r.prototype[Du]=!0,Ye(n,{get:function(t,e){return this.has(t)?t:e},includes:function(t){return this.has(t)},keySeq:function(){return this.valueSeq()}}),n.prototype.has=ir.includes,n.prototype.contains=n.prototype.includes,Ye(x,u.prototype),Ye(L,r.prototype),Ye(O,n.prototype),Ye(et,u.prototype),Ye(ut,r.prototype),Ye(rt,n.prototype),{Iterable:e,Seq:I,Collection:tt,Map:Dt,OrderedMap:$t,List:Tt,Stack:He,Set:je,OrderedSet:Ue,Record:Oe,Range:Z,Repeat:Q,is:V,fromJS:J}})},function(t,e){function u(t,e){for(var u=-1,r=t?t.length:0,n=Array(r);++u<r;)n[u]=e(t[u],u,t);return n}function r(t,e,u,r){for(var n=t.length,i=u+(r?1:-1);r?i--:++i<n;)if(e(t[i],i,t))return i;return-1}function n(t,e,u){if(e!==e)return r(t,i,u);for(var n=u-1,o=t.length;++n<o;)if(t[n]===e)return n;return-1}function i(t){return t!==t}function o(t,e){for(var u=-1,r=Array(t);++u<t;)r[u]=e(u);return r}function a(t,e){return u(e,function(e){return t[e]})}function s(t,e){var u=X(t)||l(t)?o(t.length,String):[],r=u.length,n=!!r;for(var i in t)!e&&!U.call(t,i)||n&&("length"==i||c(i,r))||u.push(i);return u}function f(t){if(!D(t))return J(t);var e=[];for(var u in Object(t))U.call(t,u)&&"constructor"!=u&&e.push(u);return e}function c(t,e){return!!(e=null==e?w:e)&&("number"==typeof t||T.test(t))&&t>-1&&t%1==0&&t<e}function D(t){var e=t&&t.constructor;return t===("function"==typeof e&&e.prototype||N)}function l(t){return p(t)&&U.call(t,"callee")&&(!K.call(t,"callee")||W.call(t)==x)}function h(t){return null!=t&&_(t.length)&&!d(t)}function p(t){return F(t)&&h(t)}function d(t){var e=v(t)?W.call(t):"";return e==L||e==O}function _(t){return"number"==typeof t&&t>-1&&t%1==0&&t<=w}function v(t){var e=typeof t;return!!t&&("object"==e||"function"==e)}function F(t){return!!t&&"object"==typeof t}function E(t){return"string"==typeof t||!X(t)&&F(t)&&W.call(t)==z}function C(t){return"symbol"==typeof t||F(t)&&W.call(t)==M}function A(t){return t?(t=B(t))===S||t===-S?(t<0?-1:1)*b:t===t?t:0:0===t?t:0}function y(t){var e=A(t),u=e%1;return e===e?u?e-u:e:0}function B(t){if("number"==typeof t)return t;if(C(t))return I;if(v(t)){var e="function"==typeof t.valueOf?t.valueOf():t;t=v(e)?e+"":e}if("string"!=typeof t)return 0===t?t:+t;t=t.replace(R,"");var u=j.test(t);return u||P.test(t)?q(t.slice(2),u?2:8):k.test(t)?I:+t}function g(t){return h(t)?s(t):f(t)}function m(t){return t?a(t,g(t)):[]}var S=1/0,w=9007199254740991,b=1.7976931348623157e308,I=NaN,x="[object Arguments]",L="[object Function]",O="[object GeneratorFunction]",z="[object String]",M="[object Symbol]",R=/^\s+|\s+$/g,k=/^[-+]0x[0-9a-f]+$/i,j=/^0b[01]+$/i,P=/^0o[0-7]+$/i,T=/^(?:0|[1-9]\d*)$/,q=parseInt,N=Object.prototype,U=N.hasOwnProperty,W=N.toString,K=N.propertyIsEnumerable,J=function(t,e){return function(u){return t(e(u))}}(Object.keys,Object),H=Math.max,X=Array.isArray;t.exports=function(t,e,u,r){t=h(t)?t:m(t),u=u&&!r?y(u):0;var i=t.length;return u<0&&(u=H(i+u,0)),E(t)?u<=i&&t.indexOf(e,u)>-1:!!i&&n(t,e,u)>-1}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.Sequence=e.Run=e.Pairing=e.EmbeddingLevelState=e.DirectionalStatusStackEntry=e.BracketPairState=e.BracketPairStackEntry=e.decrease=e.increase=void 0;var r=u(1),n=(0,r.Record)({isolate:!1,level:0,override:"neutral"}),i=(0,r.Record)({directionalStatusStack:r.Stack.of(new n),bidiTypes:r.List.of(),embeddingLevels:r.List.of(),overflowEmbeddingCount:0,overflowIsolateCount:0,validIsolateCount:0}),o=(0,r.Record)({level:-1,from:0,to:0},"Run"),a=(0,r.Record)({runs:r.List.of(),eos:"",sos:""},"Sequence"),s=(0,r.Record)({point:0,position:0}),f=(0,r.Record)({open:0,close:0}),c=(0,r.Record)({stack:r.Stack.of(),pairings:r.List.of(),stackoverflow:!1});e.increase=function(t){return t+1},e.decrease=function(t){return t-1},e.BracketPairStackEntry=s,e.BracketPairState=c,e.DirectionalStatusStackEntry=n,e.EmbeddingLevelState=i,e.Pairing=f,e.Run=o,e.Sequence=a},function(t,e,u){(function(e){function u(t,e,u){switch(u.length){case 0:return t.call(e);case 1:return t.call(e,u[0]);case 2:return t.call(e,u[0],u[1]);case 3:return t.call(e,u[0],u[1],u[2])}return t.apply(e,u)}function r(t,e){for(var u=-1,r=e.length,n=t.length;++u<r;)t[n+u]=e[u];return t}function n(t,e,u,i,a){var s=-1,f=t.length;for(u||(u=o),a||(a=[]);++s<f;){var c=t[s];e>0&&u(c)?e>1?n(c,e-1,u,i,a):r(a,c):i||(a[a.length]=c)}return a}function i(t,e){return e=b(void 0===e?t.length-1:e,0),function(){for(var r=arguments,n=-1,i=b(r.length-e,0),o=Array(i);++n<i;)o[n]=r[e+n];n=-1;for(var a=Array(e+1);++n<e;)a[n]=r[n];return a[e]=o,u(t,this,a)}}function o(t){return I(t)||a(t)||!!(w&&t&&t[w])}function a(t){return f(t)&&B.call(t,"callee")&&(!S.call(t,"callee")||g.call(t)==_)}function s(t){return null!=t&&D(t.length)&&!c(t)}function f(t){return h(t)&&s(t)}function c(t){var e=l(t)?g.call(t):"";return e==v||e==F}function D(t){return"number"==typeof t&&t>-1&&t%1==0&&t<=d}function l(t){var e=typeof t;return!!t&&("object"==e||"function"==e)}function h(t){return!!t&&"object"==typeof t}var p="Expected a function",d=9007199254740991,_="[object Arguments]",v="[object Function]",F="[object GeneratorFunction]",E="object"==typeof e&&e&&e.Object===Object&&e,C="object"==typeof self&&self&&self.Object===Object&&self,A=E||C||Function("return this")(),y=Object.prototype,B=y.hasOwnProperty,g=y.toString,m=A.Symbol,S=y.propertyIsEnumerable,w=m?m.isConcatSpreadable:void 0,b=Math.max,I=Array.isArray,x=function(t){return i(function(e){var u=(e=n(e,1)).length,r=u;for(t&&e.reverse();r--;)if("function"!=typeof e[r])throw new TypeError(p);return function(){for(var t=0,r=u?e[t].apply(this,arguments):arguments[0];++t<u;)r=e[t].call(this,r);return r}})}();t.exports=x}).call(e,u(5))},function(t,e){var u;u=function(){return this}();try{u=u||Function("return this")()||(0,eval)("this")}catch(t){"object"==typeof window&&(u=window)}t.exports=u},function(t,e){t.exports=function(t){return void 0===t}},function(t,e,u){"use strict";function r(t){return t&&t.__esModule?t:{default:t}}Object.defineProperty(e,"__esModule",{value:!0});var n=function(){function t(t,e){var u=[],r=!0,n=!1,i=void 0;try{for(var o,a=t[Symbol.iterator]();!(r=(o=a.next()).done)&&(u.push(o.value),!e||u.length!==e);r=!0);}catch(t){n=!0,i=t}finally{try{!r&&a.return&&a.return()}finally{if(n)throw i}}return u}return function(e,u){if(Array.isArray(e))return e;if(Symbol.iterator in Object(e))return t(e,u);throw new TypeError("Invalid attempt to destructure non-iterable instance")}}(),i=r(u(2)),o=u(1),a=r(u(15)),s=r(u(26)),f=r(u(11)),c=r(u(27)),D=u(0),l=u(3);e.default=function(t,e){function u(t){var e=t.last().get("to")-1,r=B.get(e,-1);if(r>-1){var n=(0,c.default)(p,r);return u(t.push(n))}return t}var r=arguments.length>2&&void 0!==arguments[2]?arguments[2]:0,h=(0,a.default)(t,e,r),p=h.runs,d=h.bidiTypes,_=h.levels,v=(0,s.default)(t.zip(d,e).filter(function(t){var e=n(t,3),u=(e[0],e[1]);return e[2],!1===(0,D.isX9ControlCharacter)(u)})),F=n(v,3),E=F[0],C=F[1],A=F[2],y=(0,f.default)(E),B=y.initiatorToPDI,g=y.initiatorFromPDI;return{sequences:function(t){return t.map(function(t,e){var u=E.size,n=t.get("runs").first().get("from"),a=t.get("runs").last().get("to"),s=function(t){return(0,o.Range)(0,u).contains(t)?(0,c.default)(p,t).get("level"):r},f=s(n-1),l=s(n),h=function(t){var e=E.get(a-1),u=B.get(e,-1);return(0,i.default)([D.LRI,D.RLI,D.FSI],e)&&-1===u?r:s(a)}(),d=Math.max(f,l)%2==1?"R":"L",_=Math.max(l,h)%2==1?"R":"L";return t.set("sos",d).set("eos",_)})}(p.filter(function(t){var e=t.get("from"),u=E.get(e),r=g.get(e,-1);return u!==D.PDI||-1===r}).reduce(function(t,e,r){var n=new l.Sequence({runs:u(o.List.of(e))});return t.push(n)},o.List.of())),codepoints:E,bidiTypes:C,paragraphBidiTypes:A,levels:_}}},function(t,e,u){"use strict";function r(t){var e=t.get("overflowIsolateCount"),u=t.get("overflowEmbeddingCount");return e>0||u>0}Object.defineProperty(e,"__esModule",{value:!0});var n=function(t){return t&&t.__esModule?t:{default:t}}(u(4)),i=u(0),o=u(3);e.default=function(t,e,u,a){if(t!==i.RLI)return a;var s=a.get("directionalStatusStack").peek(),f=s.get("level");return(0,n.default)(function(t){return t.update("embeddingLevels",function(t){return t.set(u,f)})},function(t){var e=s.get("override");if("neutral"!==e){var r="left-to-right"===e?"L":"R";return t.update("bidiTypes",function(t){return t.set(u,r)})}return t},function(t){var e=f+1+f%2;return e>i.MAX_DEPTH||r(t)?t.update("overflowIsolateCount",o.increase):t.update("validIsolateCount",o.increase).update("directionalStatusStack",function(t){return t.push(new o.DirectionalStatusStackEntry({isolate:!0,level:e}))})})(a)}},function(t,e,u){"use strict";function r(t){var e=t.get("overflowIsolateCount"),u=t.get("overflowEmbeddingCount");return e>0||u>0}Object.defineProperty(e,"__esModule",{value:!0});var n=function(t){return t&&t.__esModule?t:{default:t}}(u(4)),i=u(3),o=u(0);e.default=function(t,e,u,a){if(t!==o.LRI)return a;var s=a.get("directionalStatusStack").peek(),f=s.get("level");return(0,n.default)(function(t){return t.update("embeddingLevels",function(t){return t.set(u,f)})},function(t){var e=s.get("override");if("neutral"!==e){var r="left-to-right"===e?"L":"R";return t.update("bidiTypes",function(t){return t.set(u,r)})}return t},function(t){var e=f+1+(f+1)%2;return e>o.MAX_DEPTH||r(t)?t.update("overflowIsolateCount",i.increase):t.update("validIsolateCount",i.increase).update("directionalStatusStack",function(t){return t.push(new i.DirectionalStatusStackEntry({isolate:!0,level:e}))})})(a)}},function(t,e,u){"use strict";function r(t){return t&&t.__esModule?t:{default:t}}Object.defineProperty(e,"__esModule",{value:!0});var n=function(){function t(t,e){var u=[],r=!0,n=!1,i=void 0;try{for(var o,a=t[Symbol.iterator]();!(r=(o=a.next()).done)&&(u.push(o.value),!e||u.length!==e);r=!0);}catch(t){n=!0,i=t}finally{try{!r&&a.return&&a.return()}finally{if(n)throw i}}return u}return function(e,u){if(Array.isArray(e))return e;if(Symbol.iterator in Object(e))return t(e,u);throw new TypeError("Invalid attempt to destructure non-iterable instance")}}(),i=(r(u(6)),r(u(2))),o=u(1),a=u(0);e.default=function(t,e){(0,o.Record)({inside:!1,counter:0},"P2State");var u=t.reduce(function(t,e){var u=t.get(-1,0);return t.push((0,i.default)([a.LRI,a.RLI,a.FSI],e)?u+1:e===a.PDI&&u>0?u-1:u)},o.List.of()).map(function(t){return t>0}),r=t.zip(e,u).filter(function(t){var e=n(t,3);return e[0],e[1],!1===e[2]}).map(function(t){var e=n(t,3),u=(e[0],e[1]);return e[2],u}).find(function(t){return(0,i.default)(["L","R","AL"],t)});return(0,i.default)(["R","AL"],r)?1:0}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=function(){function t(t,e){var u=[],r=!0,n=!1,i=void 0;try{for(var o,a=t[Symbol.iterator]();!(r=(o=a.next()).done)&&(u.push(o.value),!e||u.length!==e);r=!0);}catch(t){n=!0,i=t}finally{try{!r&&a.return&&a.return()}finally{if(n)throw i}}return u}return function(e,u){if(Array.isArray(e))return e;if(Symbol.iterator in Object(e))return t(e,u);throw new TypeError("Invalid attempt to destructure non-iterable instance")}}(),n=u(1),i=function(t){return t&&t.__esModule?t:{default:t}}(u(22));e.default=function(t){var e=t.size,u=(0,n.Range)().zip((0,n.Range)(0,e).map(function(e){return(0,i.default)(t,e)})).filter(function(t){var e=r(t,2);return e[0],-1!==e[1]}),o=u.map(function(t){var e=r(t,2),u=e[0];return[e[1],u]});return{initiatorToPDI:(0,n.Map)(u),initiatorFromPDI:(0,n.Map)(o)}}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=function(){function t(t,e){var u=[],r=!0,n=!1,i=void 0;try{for(var o,a=t[Symbol.iterator]();!(r=(o=a.next()).done)&&(u.push(o.value),!e||u.length!==e);r=!0);}catch(t){n=!0,i=t}finally{try{!r&&a.return&&a.return()}finally{if(n)throw i}}return u}return function(e,u){if(Array.isArray(e))return e;if(Symbol.iterator in Object(e))return t(e,u);throw new TypeError("Invalid attempt to destructure non-iterable instance")}}(),n=u(1);e.default=function(t){var e=t.reduce(function(t,e){var u=r(e,2),n=u[0],i=u[1];return t.update(0,function(t){return t.push(n)}).update(1,function(t){return t.push(i)})},n.List.of(n.List.of(),n.List.of()));return[e.get(0),e.get(1)]}},function(t,e,u){"use strict";function r(t){return t&&t.__esModule?t:{default:t}}Object.defineProperty(e,"__esModule",{value:!0}),e.reorderPermutation=e.reorder=e.resolve=void 0;var n=u(14),i=u(44),o=r(i),a=r(u(46)),s=r(u(47)),f=u(1);e.resolve=function(t,e){var u=arguments.length>2&&void 0!==arguments[2]&&arguments[2],r=s.default.ucs2.encode(t).normalize("NFC"),i=s.default.ucs2.decode(r),o=(0,f.fromJS)(i),c=o.map(a.default);return(0,n.resolvedLevelsWithInvisibles)(o,c,e,u).toJS()},e.reorder=function(t,e){var u=arguments.length>2&&void 0!==arguments[2]&&arguments[2];return(0,o.default)((0,f.fromJS)(t),(0,f.fromJS)(e),u).toJS()},e.reorderPermutation=function(t){return(0,i.reorderPermutation)((0,f.fromJS)(t)).toJS()}},function(t,e,u){"use strict";function r(t){return t&&t.__esModule?t:{default:t}}function n(t,e,u){var r=!0===(arguments.length>3&&void 0!==arguments[3]&&arguments[3])?(0,f.default)(t,e):u,n=(0,a.default)(t,e,r),s=n.sequences,h=n.codepoints,p=n.bidiTypes,d=n.paragraphBidiTypes,_=(n.levels,(0,D.default)(h,p,s)),v=p.size,F=s.reduce(i,(0,o.List)((0,o.Range)(0,v)).map(function(t){return 0})),E=(0,c.default)(_,F);return(0,l.default)(d,E,r)}function i(t,e){return e.get("runs").reduce(function(t,e){var u=e.toJS(),r=u.from,n=u.to,i=n-r,a=e.get("level"),s=(0,o.List)((0,o.Range)(0,i)).map(function(t){return a});return t.slice(0,r).concat(s).concat(t.slice(n))},t)}Object.defineProperty(e,"__esModule",{value:!0}),e.resolvedLevelsWithInvisibles=void 0;var o=u(1),a=r(u(7)),s=u(0),f=(r(u(12)),r(u(28)),r(u(10))),c=r(u(29)),D=r(u(30)),l=(r(u(2)),r(u(43)));e.resolvedLevelsWithInvisibles=function(t,e,u){function r(t,e,u){return 0===t.size?u:(0,s.isX9ControlCharacter)(t.first())?r(t.rest(),e,u.push("x")):r(t.rest(),e.rest(),u.push(e.first()))}return r(e,n(t,e,u,arguments.length>3&&void 0!==arguments[3]&&arguments[3]),o.List.of())},e.default=n},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=function(){function t(t,e){var u=[],r=!0,n=!1,i=void 0;try{for(var o,a=t[Symbol.iterator]();!(r=(o=a.next()).done)&&(u.push(o.value),!e||u.length!==e);r=!0);}catch(t){n=!0,i=t}finally{try{!r&&a.return&&a.return()}finally{if(n)throw i}}return u}return function(e,u){if(Array.isArray(e))return e;if(Symbol.iterator in Object(e))return t(e,u);throw new TypeError("Invalid attempt to destructure non-iterable instance")}}(),n=(function(t){t&&t.__esModule}(u(2)),u(1)),i=u(0),o=u(3),a=u(16);e.default=function(t,e){var u=arguments.length>2&&void 0!==arguments[2]?arguments[2]:0,s=[a.rle,a.lre,a.rlo,a.lro,a.rli,a.lri,a.fsi,a.other,a.pdi,a.pdf],f=n.Stack.of(new o.DirectionalStatusStackEntry({level:u})),c=new o.EmbeddingLevelState({directionalStatusStack:f}).set("bidiTypes",e).set("embeddingLevels",t.map(function(t){return u})),D=t.zip(e).reduce(function(u,n,i){var o=r(n,2),a=o[0],f=o[1];return s.reduce(function(u,r){return r(a,f,i,u,t,e)},u)},c);return{runs:t.zip(e,D.get("embeddingLevels")).filter(function(t){var e=r(t,3),u=(e[0],e[1]);return e[2],!1===(0,i.isX9ControlCharacter)(u)}).reduce(function(t,e,u){var n=r(e,3),i=(n[0],n[1],n[2]),a=t.size-1;return t.getIn([a,"level"],-1)===i?t.updateIn([a,"to"],o.increase):t.push(new o.Run({level:i,from:u,to:u+1}))},n.List.of()),bidiTypes:D.get("bidiTypes"),levels:D.get("embeddingLevels")}}},function(t,e,u){"use strict";function r(t){return t&&t.__esModule?t:{default:t}}Object.defineProperty(e,"__esModule",{value:!0}),e.pdf=e.pdi=e.other=e.fsi=e.lri=e.rli=e.lro=e.rlo=e.lre=e.rle=void 0;var n=u(17),i=r(u(18)),o=r(u(19)),a=r(u(20)),s=r(u(8)),f=r(u(9)),c=r(u(21)),D=r(u(23)),l=u(24),h=u(25);e.rle=n.rle,e.lre=i.default,e.rlo=o.default,e.lro=a.default,e.rli=s.default,e.lri=f.default,e.fsi=c.default,e.other=D.default,e.pdi=l.pdi,e.pdf=h.pdf},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.rle=void 0;var r=u(0),n=u(3),i=function(t){return t&&t.__esModule?t:{default:t}}(u(4));e.rle=function(t,e,u,o){if(t!==r.RLE)return o;var a=o.get("directionalStatusStack").peek().get("level");return(0,i.default)(function(t){return t.setIn(["embeddingLevels","levels",u],a)},function(t){var e=a+1+a%2,u=e>r.MAX_DEPTH,i=t.get("overflowIsolateCount"),o=t.get("overflowEmbeddingCount"),s=i>0||o>0;if(u||s)return 0===i?t.update("overflowEmbeddingCount",n.increase):t;var f=new n.DirectionalStatusStackEntry({level:e});return t.update("directionalStatusStack",function(t){return t.push(f)})})(o)}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=function(t){return t&&t.__esModule?t:{default:t}}(u(4)),n=u(0),i=u(3);e.default=function(t,e,u,o){if(t!==n.LRE)return o;var a=o.get("directionalStatusStack").peek().get("level");return(0,r.default)(function(t){return t.setIn(["embeddingLevels","levels",u],a)},function(t){var e=a+1+(a+1)%2,u=e>n.MAX_DEPTH,r=t.get("overflowIsolateCount"),o=t.get("overflowEmbeddingCount"),s=r>0||o>0;if(u||s)return 0===r?t.update("overflowEmbeddingCount",i.increase):t;var f=new i.DirectionalStatusStackEntry({level:e});return t.update("directionalStatusStack",function(t){return t.push(f)})})(o)}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=u(0),n=u(3);e.default=function(t,e,u,i){if(t!==r.RLO)return i;var o=i.get("directionalStatusStack").peek().get("level"),a=i.get("overflowIsolateCount"),s=i.get("overflowEmbeddingCount"),f=o+1+o%2,c=f>r.MAX_DEPTH,D=a>0||s>0;return c||D?0===a?i.update("overflowEmbeddingCount",n.increase):i:i.update("directionalStatusStack",function(t){return t.push(new n.DirectionalStatusStackEntry({level:f,override:"right-to-left"}))})}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=u(0),n=u(3);e.default=function(t,e,u,i){if(t!==r.LRO)return i;var o=i.get("directionalStatusStack").peek().get("level"),a=i.get("overflowIsolateCount"),s=i.get("overflowEmbeddingCount"),f=o+1+(o+1)%2,c=f>r.MAX_DEPTH,D=a>0||s>0;return c||D?0===a?i.update("overflowEmbeddingCount",n.increase):i:i.update("directionalStatusStack",function(t){return t.push(new n.DirectionalStatusStackEntry({level:f,override:"left-to-right"}))})}},function(t,e,u){"use strict";function r(t){return t&&t.__esModule?t:{default:t}}Object.defineProperty(e,"__esModule",{value:!0});var n=r(u(8)),i=r(u(9)),o=r(u(10)),a=r(u(11)),s=u(0);e.default=function(t,e,u,r,f,c){if(t!==s.FSI)return r;var D=(0,a.default)(f).initiatorToPDI.get(u,-1),l=u+1,h=D>-1?D:f.size,p=f.slice(l,h),d=c.slice(l,h);return 1===(0,o.default)(p,d)?(0,n.default)(s.RLI,e,u,r,f):(0,i.default)(s.LRI,e,u,r,f)}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=function(t){return t&&t.__esModule?t:{default:t}}(u(2)),n=u(0),i=u(1);e.default=function(t,e){if(e>=t.size)return-1;if(!(0,r.default)([n.LRI,n.RLI,n.FSI],t.get(e)))return-1;var u=t.slice(e+1),o=(0,i.Record)({counter:1,index:-1},"BD9State");return u.reduce(function(t,u,i){if(t.get("index")>-1)return t;var a=function(){var e=t.get("counter");return(0,r.default)([n.LRI,n.RLI,n.FSI],u)?e+1:u===n.PDI?e-1:e}();return u===n.PDI&&0===a?new o({counter:a,index:e+(i+1)}):t.set("counter",a)},new o).get("index")}},function(t,e,u){"use strict";function r(t){return t&&t.__esModule?t:{default:t}}Object.defineProperty(e,"__esModule",{value:!0});var n=r(u(4)),i=(r(u(2)),u(0));e.default=function(t,e,u,r){if((0,i.isNonFormatting)(e))return r;var o=r.get("directionalStatusStack").peek(),a=o.get("level");return(0,n.default)(function(t){return t.update("embeddingLevels",function(t){return t.set(u,a)})},function(t){var e=o.get("override");if("neutral"!==e){var r="left-to-right"===e?"L":"R";return t.update("bidiTypes",function(t){return t.set(u,r)})}return t})(r)}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.pdi=void 0;var r=function(t){return t&&t.__esModule?t:{default:t}}(u(4)),n=u(0),i=u(3);e.pdi=function(t,e,u,o){if(t!==n.PDI)return o;var a=o.get("overflowIsolateCount"),s=o.get("validIsolateCount");return(0,r.default)(function(t){return a>0?t.update("overflowIsolateCount",i.decrease):0===s?t:t.set("overflowEmbeddingCount",0).update("directionalStatusStack",function(t){return t.skipWhile(function(t){return!1===t.get("isolate")})}).update("directionalStatusStack",function(t){return t.pop()}).update("validIsolateCount",i.decrease)},function(t){var e=t.get("directionalStatusStack").peek().get("level");return t.update("embeddingLevels",function(t){return t.set(u,e)})},function(t){var e=t.get("directionalStatusStack").peek().get("override");if("neutral"!==e){var r="left-to-right"===e?"L":"R";return t.setIn(["bidiTypes",u],r)}return t})(o)}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.pdf=void 0;var r=u(0),n=u(3),i=function(t){return t&&t.__esModule?t:{default:t}}(u(4));e.pdf=function(t,e,u,o){return t!==r.PDF?o:(0,i.default)(function(t){var e=t.get("directionalStatusStack").peek().get("level");return t.setIn(["embeddingLevels","levels",u],e)},function(t){var e=t.get("overflowIsolateCount"),u=t.get("overflowEmbeddingCount"),r=t.get("directionalStatusStack"),i=r.peek().get("isolate");return e>0?t:u>0?t.update("overflowEmbeddingCount",n.decrease):!1===i&&r.size>=2?t.set("directionalStatusStack",r.pop()):t})(o)}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=function(){function t(t,e){var u=[],r=!0,n=!1,i=void 0;try{for(var o,a=t[Symbol.iterator]();!(r=(o=a.next()).done)&&(u.push(o.value),!e||u.length!==e);r=!0);}catch(t){n=!0,i=t}finally{try{!r&&a.return&&a.return()}finally{if(n)throw i}}return u}return function(e,u){if(Array.isArray(e))return e;if(Symbol.iterator in Object(e))return t(e,u);throw new TypeError("Invalid attempt to destructure non-iterable instance")}}(),n=u(1);e.default=function(t){var e=t.reduce(function(t,e){var u=r(e,3),n=u[0],i=u[1],o=u[2];return t.update(0,function(t){return t.push(n)}).update(1,function(t){return t.push(i)}).update(2,function(t){return t.push(o)})},n.List.of(n.List.of(),n.List.of(),n.List.of()));return[e.get(0),e.get(1),e.get(2)]}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=u(3);e.default=function(t,e){var u=t.filter(function(t){return e>=t.get("from")&&e<t.get("to")});return u.size>0?u.last():new r.Run}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=u(1);e.default=function(t){return t.butLast().reduce(function(t,e){var u=e.toJS(),r=u.from,n=u.to-r,i=t.get(-1);return t.push(n+i)},r.List.of(0))}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.default=function(t,e){return t.zipWith(function(t,e){return"L"===t?e+e%2:"R"===t?e+(e+1)%2:"AN"===t||"EN"===t?e+1+(e+1)%2:void 0},e)}},function(t,e,u){"use strict";function r(t){return t&&t.__esModule?t:{default:t}}function n(t,e,u){var r=t.zip(e),n=(0,s.default)(u.get("runs").map(function(t){var e=t.toJS(),u=e.from,n=e.to;return r.slice(u,n)}).flatten()),l=i(n,2),h=l[0],p=l[1],d=[a.nsm,a.en,a.al,a.es,a.et,a.on,a.enToL,c.default,f.default,D.default].reduce(function(t,e){var r=u.get("runs").first().get("level");return e(t,h,u.get("sos"),u.get("eos"),r,p)},p),_=u.get("runs").butLast().reduce(function(t,e){var u=e.toJS(),r=u.from,n=u.to-r,i=t.get(-1);return t.push(n+i)},o.List.of(0)),v=u.get("runs").zip(_).map(function(t){var e=i(t,2),u=e[0],r=e[1],n=u.toJS(),o=n.from,a=n.to-o;return d.slice(r,r+a)});return u.get("runs").zip(v).reduce(function(t,e){var u=i(e,2),r=u[0],n=u[1],o=r.toJS(),a=o.from,s=o.to;return t.slice(0,a).concat(n).concat(t.slice(s))},e)}Object.defineProperty(e,"__esModule",{value:!0});var i=function(){function t(t,e){var u=[],r=!0,n=!1,i=void 0;try{for(var o,a=t[Symbol.iterator]();!(r=(o=a.next()).done)&&(u.push(o.value),!e||u.length!==e);r=!0);}catch(t){n=!0,i=t}finally{try{!r&&a.return&&a.return()}finally{if(n)throw i}}return u}return function(e,u){if(Array.isArray(e))return e;if(Symbol.iterator in Object(e))return t(e,u);throw new TypeError("Invalid attempt to destructure non-iterable instance")}}(),o=u(1),a=u(31),s=(r(u(7)),u(0),r(u(12))),f=r(u(39)),c=r(u(40)),D=r(u(42));e.default=function(t,e,u){return u.reduce(function(e,u){return n(t,e,u)},e)}},function(t,e,u){"use strict";function r(t){return t&&t.__esModule?t:{default:t}}Object.defineProperty(e,"__esModule",{value:!0}),e.enToL=e.on=e.et=e.es=e.al=e.en=e.nsm=void 0;var n=r(u(32)),i=r(u(33)),o=r(u(34)),a=r(u(35)),s=r(u(36)),f=r(u(37)),c=r(u(38));e.nsm=n.default,e.en=i.default,e.al=o.default,e.es=a.default,e.et=s.default,e.on=f.default,e.enToL=c.default},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=u(1),n=u(0);e.default=function(t,e,u,i){return t.reduce(function(t,r,i){if("NSM"!==r)return t.push(r);if(i<=0)return t.push(u);var o=t.get(i-1),a=e.get(i-1);return(0,n.isIsolateInitiator)(o)||(0,n.isPDI)(a)?t.push("ON"):t.push(o)},r.List.of())}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=u(0);e.default=function(t,e,u,n,i){return t.map(function(e,n){return"EN"!==e?e:"AL"===t.slice(0,n).reverse().push(u).find(function(t){return(0,r.isStrong)(t)})?"AN":e})}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.default=function(t){return t.map(function(t){return"AL"===t?"R":t})}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=function(t){return t&&t.__esModule?t:{default:t}}(u(2));e.default=function(t){if(t.size<3)return t;var e=function(t){return(0,r.default)(["AN","EN"],t)},u=t.take(1),n=t.skip(2).zipWith(function(t,u,r){return"EN"===t&&t===r&&"ES"===u?"EN":"CS"===u&&e(t)&&t===r?t:u},t.skip(1),t),i=t.last();return u.concat(n).push(i)}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=u(0);e.default=function(t){return t.map(function(e,u){if("ET"!==e)return e;var n=t.slice(0,u).reverse(),i=t.slice(u),o="EN"===n.skipWhile(r.isET).first(),a="EN"===i.skipWhile(r.isET).first();return o||a?"EN":e})}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=function(t){return t&&t.__esModule?t:{default:t}}(u(2));e.default=function(t,e){return t.map(function(t,e){return(0,r.default)(["ET","ES","CS","B","S"],t)?"ON":t})}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=u(0);e.default=function(t,e,u,n,i){return t.map(function(e,n){return"EN"!==e?e:"L"===t.slice(0,n).reverse().push(u).find(function(t){return(0,r.isStrong)(t)})?"L":e})}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=u(0);e.default=function(t,e,u,n,i){return t.map(function(e,i){if(!(0,r.isNI)(e))return e;var o=t.slice(0,i).reverse().push(u),a=t.slice(i).push(n),s=o.skipWhile(r.isNI).first(),f=a.skipWhile(r.isNI).first();return"L"===s&&"L"===f?"L":(0,r.isR)(s)&&(0,r.isR)(f)?"R":e})}},function(t,e,u){"use strict";function r(t){return t&&t.__esModule?t:{default:t}}Object.defineProperty(e,"__esModule",{value:!0});r(u(6));var n=r(u(41)),i=r(u(4)),o=r(u(2));e.default=function(t,e,u,r,a,s){var f=(0,n.default)(e);return(0,i.default)(function(){return f.reduce(function(t,e){var r=e.get("open"),n=e.get("close");if(t.get(r)!==t.get(n))return t;var i=t.slice(r,n+1).map(function(t){return(0,o.default)(["EN","AN"],t)?"R":t}),s=a%2==0?"L":"R",f=a%2==0?"R":"L",c=i.find(function(t){return t===s}),D=i.find(function(t){return t===f});return c?t.set(r,s).set(n,s):D?t.slice(0,r).map(function(t){return(0,o.default)(["EN","AN"],t)?"R":t}).reverse().push(u).find(function(t){return(0,o.default)(["L","R"],t)})===f?t.set(r,f).set(n,f):t.set(r,s).set(n,s):t},t)},function(t){return f.reduce(function(t,e){var u=e.get("open"),r=e.get("close"),n=(0,o.default)(["L","R"],t.get(u)),a=(0,o.default)(["L","R"],t.get(r));return(0,i.default)(function(t){return"NSM"===s.get(u+1)&&n?t.set(u+1,t.get(u)):t},function(t){return"NSM"===s.get(r+1)&&a?t.set(r+1,t.get(r)):t})(t)},t)})()}},function(t,e,u){"use strict";function r(t){return t&&t.__esModule?t:{default:t}}Object.defineProperty(e,"__esModule",{value:!0});var n=r(u(6)),i=(r(u(2)),u(3)),o=u(0);e.default=function(t,e){var u=new i.BracketPairState;return t.reduce(function(t,e,u){if(!0===t.get("stackoverflow"))return t;var r=t.get("stack");if((0,o.isOpeningBracket)(e,"ON"))return 63==r.size?t.set("stackoverflow",!0):t.set("stack",r.push(new i.BracketPairStackEntry({point:(0,o.oppositeBracket)(e),position:u})));if((0,o.isClosingBracket)(e,"ON")&&r.size>0){var a=r.findKey(function(t){return t.get("point")===e});if((0,n.default)(a))return t;var s=r.getIn([a,"position"]);return t.set("stack",r.slice(a+1)).update("pairings",function(t){return t.push(new i.Pairing({open:s,close:u}))})}return t},u).get("pairings").sort(function(t,e){return t.get("open")-e.get("open")})}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=u(0);e.default=function(t,e,u,n,i){var o=i%2==0?"L":"R";return t.map(function(t,e){return(0,r.isNI)(t)?o:t})}},function(t,e,u){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=function(){function t(t,e){var u=[],r=!0,n=!1,i=void 0;try{for(var o,a=t[Symbol.iterator]();!(r=(o=a.next()).done)&&(u.push(o.value),!e||u.length!==e);r=!0);}catch(t){n=!0,i=t}finally{try{!r&&a.return&&a.return()}finally{if(n)throw i}}return u}return function(e,u){if(Array.isArray(e))return e;if(Symbol.iterator in Object(e))return t(e,u);throw new TypeError("Invalid attempt to destructure non-iterable instance")}}(),n=function(t){return t&&t.__esModule?t:{default:t}}(u(2)),i=function(t){return(0,n.default)(["WS","FSI","LRI","RLI","PDI"],t)};e.default=function(t,e,u){return t.zip(e).map(function(e,o){var a=r(e,2),s=a[0],f=a[1];if((0,n.default)(["S","B"],s))return u;if(!i(s))return f;var c=t.slice(o).push("<EOL>").skipWhile(i).first();return(0,n.default)(["<EOL>","S","B"],c)?u:f})}},function(t,e,u){"use strict";function r(t,e){var u=n(e,0).groupBy(function(t){return t.get("level")}),a=u.keySeq().max();if(!(0,o.default)(a)||a<0)return t;if(0===a)return t;var f=u.get(a);return r(f.reduce(function(t,e){var u=e.toJS(),r=u.from,n=u.to,i=t.slice(r,n).reverse();return s(t,r,n,i)},t),f.reduce(function(t,e){var u=e.toJS(),r=u.from,n=u.to,o=(0,i.List)((0,i.Range)(0,n-r)).map(function(t){return a-1});return s(t,r,n,o)},e))}function n(t,e){var u=t.size;if(0===u)return i.List.of();var r=t.first(),o=t.findKey(function(t){return t!=r}),s=void 0===o?u:o,f=new a({level:r,from:e,to:e+s});return i.List.of(f).concat(n(t.slice(s),e+s))}Object.defineProperty(e,"__esModule",{value:!0}),e.reorderPermutation=void 0;var i=u(1),o=function(t){return t&&t.__esModule?t:{default:t}}(u(45)),a=(0,i.Record)({level:-1,from:0,to:0},"ReorderPair"),s=function(t,e,u,r){var n=t.slice(0,e),i=t.slice(u);return n.concat(r).concat(i)};e.reorderPermutation=function(t){var e=arguments.length>1&&void 0!==arguments[1]?arguments[1]:"x",u=r((0,i.List)((0,i.Range)(0,t.size)).map(function(e){return(0,i.Map)({strip:"x"===t.get(e),index:e})}).filter(function(t){return!1===t.get("strip")}).map(function(t){return t.get("index")}),t.filter(function(t){return t!=e})),n=new((0,i.Record)({remaining:(0,i.List)(),result:(0,i.List)()},"Reduction"))({remaining:u,result:(0,i.List)()});return(0,i.List)((0,i.Range)(0,t.size)).reduce(function(e,u){if("x"==t.get(u)){var r=e.get("result").size;return e.setIn(["result",u],r)}var n=e.get("remaining");return e.setIn(["result",u],n.first()).set("remaining",n.shift())},n).get("result")},e.default=r},function(t,e){function u(t){return!!t&&"object"==typeof t}var r="[object Number]",n=Object.prototype.toString;t.exports=function(t){return"number"==typeof t||u(t)&&n.call(t)==r}},function(t,e,u){(function(e){var u;!function(e){t.exports=e()}(function(){return function t(e,r,n){function i(a,s){if(!r[a]){if(!e[a]){var f="function"==typeof u&&u;if(!s&&f)return u(a,!0);if(o)return o(a,!0);var c=new Error("Cannot find module '"+a+"'");throw c.code="MODULE_NOT_FOUND",c}var D=r[a]={exports:{}};e[a][0].call(D.exports,function(t){var u=e[a][1][t];return i(u||t)},D,D.exports,t,e,r,n)}return r[a].exports}for(var o="function"==typeof u&&u,a=0;a<n.length;a++)i(n[a]);return i}({1:[function(t,u,r){(function(t){!function(e){function n(t){throw new RangeError(L[t])}function i(t,e){for(var u=t.length,r=[];u--;)r[u]=e(t[u]);return r}function o(t,e){var u=t.split("@"),r="";return u.length>1&&(r=u[0]+"@",t=u[1]),r+i((t=t.replace(x,".")).split("."),e).join(".")}function a(t){for(var e,u,r=[],n=0,i=t.length;n<i;)(e=t.charCodeAt(n++))>=55296&&e<=56319&&n<i?56320==(64512&(u=t.charCodeAt(n++)))?r.push(((1023&e)<<10)+(1023&u)+65536):(r.push(e),n--):r.push(e);return r}function s(t){return i(t,function(t){var e="";return t>65535&&(e+=M((t-=65536)>>>10&1023|55296),t=56320|1023&t),e+=M(t)}).join("")}function f(t){return t-48<10?t-22:t-65<26?t-65:t-97<26?t-97:C}function c(t,e){return t+22+75*(t<26)-((0!=e)<<5)}function D(t,e,u){var r=0;for(t=u?z(t/g):t>>1,t+=z(t/e);t>O*y>>1;r+=C)t=z(t/O);return z(r+(O+1)*t/(t+B))}function l(t){var e,u,r,i,o,a,c,l,h,p,d=[],_=t.length,v=0,F=S,B=m;for((u=t.lastIndexOf(w))<0&&(u=0),r=0;r<u;++r)t.charCodeAt(r)>=128&&n("not-basic"),d.push(t.charCodeAt(r));for(i=u>0?u+1:0;i<_;){for(o=v,a=1,c=C;i>=_&&n("invalid-input"),((l=f(t.charCodeAt(i++)))>=C||l>z((E-v)/a))&&n("overflow"),v+=l*a,h=c<=B?A:c>=B+y?y:c-B,!(l<h);c+=C)a>z(E/(p=C-h))&&n("overflow"),a*=p;B=D(v-o,e=d.length+1,0==o),z(v/e)>E-F&&n("overflow"),F+=z(v/e),v%=e,d.splice(v++,0,F)}return s(d)}function h(t){var e,u,r,i,o,s,f,l,h,p,d,_,v,F,B,g=[];for(_=(t=a(t)).length,e=S,u=0,o=m,s=0;s<_;++s)(d=t[s])<128&&g.push(M(d));for(r=i=g.length,i&&g.push(w);r<_;){for(f=E,s=0;s<_;++s)(d=t[s])>=e&&d<f&&(f=d);for(f-e>z((E-u)/(v=r+1))&&n("overflow"),u+=(f-e)*v,e=f,s=0;s<_;++s)if((d=t[s])<e&&++u>E&&n("overflow"),d==e){for(l=u,h=C;p=h<=o?A:h>=o+y?y:h-o,!(l<p);h+=C)B=l-p,F=C-p,g.push(M(c(p+B%F,0))),l=z(B/F);g.push(M(c(l,0))),o=D(u,v,r==i),u=0,++r}++u,++e}return g.join("")}var p="object"==typeof r&&r&&!r.nodeType&&r,d="object"==typeof u&&u&&!u.nodeType&&u,_="object"==typeof t&&t;_.global!==_&&_.window!==_&&_.self!==_||(e=_);var v,F,E=2147483647,C=36,A=1,y=26,B=38,g=700,m=72,S=128,w="-",b=/^xn--/,I=/[^\x20-\x7E]/,x=/[\x2E\u3002\uFF0E\uFF61]/g,L={overflow:"Overflow: input needs wider integers to process","not-basic":"Illegal input >= 0x80 (not a basic code point)","invalid-input":"Invalid input"},O=C-A,z=Math.floor,M=String.fromCharCode;if(v={version:"1.4.1",ucs2:{decode:a,encode:s},decode:l,encode:h,toASCII:function(t){return o(t,function(t){return I.test(t)?"xn--"+h(t):t})},toUnicode:function(t){return o(t,function(t){return b.test(t)?l(t.slice(4).toLowerCase()):t})}},p&&d)if(u.exports==p)d.exports=v;else for(F in v)v.hasOwnProperty(F)&&(p[F]=v[F]);else e.punycode=v}(this)}).call(this,void 0!==e?e:"undefined"!=typeof self?self:"undefined"!=typeof window?window:{})},{}],2:[function(t,e,u){e.exports=/[\u0608\u060B\u060D\u061B\u061C\u061E-\u064A\u066D-\u066F\u0671-\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u070D\u070F\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u08A0-\u08B4\u08B6-\u08BD\uFB50-\uFBC1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFC\uFE70-\uFE74\uFE76-\uFEFC]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]/},{}],3:[function(t,e,u){e.exports=/[\u0600-\u0605\u0660-\u0669\u066B\u066C\u06DD\u08E2]|\uD803[\uDE60-\uDE7E]/},{}],4:[function(t,e,u){e.exports=/[\0-\x08\x0E-\x1B\x7F-\x84\x86-\x9F\xAD\u180E\u200B-\u200D\u2060-\u2064\u206A-\u206F\uFEFF]|\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD73-\uDD7A]|\uDB40[\uDC01\uDC20-\uDC7F]/},{}],5:[function(t,e,u){e.exports=/[,\./:\xA0\u060C\u202F\u2044\uFE50\uFE52\uFE55\uFF0C\uFF0E\uFF0F\uFF1A]/},{}],6:[function(t,e,u){e.exports=/[0-9\xB2\xB3\xB9\u06F0-\u06F9\u2070\u2074-\u2079\u2080-\u2089\u2488-\u249B\uFF10-\uFF19]|\uD800[\uDEE1-\uDEFB]|\uD835[\uDFCE-\uDFFF]|\uD83C[\uDD00-\uDD0A]/},{}],7:[function(t,e,u){e.exports=/[\+\-\u207A\u207B\u208A\u208B\u2212\uFB29\uFE62\uFE63\uFF0B\uFF0D]/},{}],8:[function(t,e,u){e.exports=/[#-%\xA2-\xA5\xB0\xB1\u058F\u0609\u060A\u066A\u09F2\u09F3\u09FB\u0AF1\u0BF9\u0E3F\u17DB\u2030-\u2034\u20A0-\u20BE\u212E\u2213\uA838\uA839\uFE5F\uFE69\uFE6A\uFF03-\uFF05\uFFE0\uFFE1\uFFE5\uFFE6]/},{}],9:[function(t,e,u){e.exports=/\u2068/},{}],10:[function(t,e,u){e.exports=/[A-Za-z\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02B8\u02BB-\u02C1\u02D0\u02D1\u02E0-\u02E4\u02EE\u0370-\u0373\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0482\u048A-\u052F\u0531-\u0556\u0559-\u055F\u0561-\u0587\u0589\u0903-\u0939\u093B\u093D-\u0940\u0949-\u094C\u094E-\u0950\u0958-\u0961\u0964-\u0980\u0982\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD-\u09C0\u09C7\u09C8\u09CB\u09CC\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E1\u09E6-\u09F1\u09F4-\u09FA\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3E-\u0A40\u0A59-\u0A5C\u0A5E\u0A66-\u0A6F\u0A72-\u0A74\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD-\u0AC0\u0AC9\u0ACB\u0ACC\u0AD0\u0AE0\u0AE1\u0AE6-\u0AF0\u0AF9\u0B02\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B3E\u0B40\u0B47\u0B48\u0B4B\u0B4C\u0B57\u0B5C\u0B5D\u0B5F-\u0B61\u0B66-\u0B77\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE\u0BBF\u0BC1\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCC\u0BD0\u0BD7\u0BE6-\u0BF2\u0C01-\u0C03\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C41-\u0C44\u0C58-\u0C5A\u0C60\u0C61\u0C66-\u0C6F\u0C7F\u0C80\u0C82\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD-\u0CC4\u0CC6-\u0CC8\u0CCA\u0CCB\u0CD5\u0CD6\u0CDE\u0CE0\u0CE1\u0CE6-\u0CEF\u0CF1\u0CF2\u0D02\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D-\u0D40\u0D46-\u0D48\u0D4A-\u0D4C\u0D4E\u0D4F\u0D54-\u0D61\u0D66-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCF-\u0DD1\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2-\u0DF4\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E4F-\u0E5B\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00-\u0F17\u0F1A-\u0F34\u0F36\u0F38\u0F3E-\u0F47\u0F49-\u0F6C\u0F7F\u0F85\u0F88-\u0F8C\u0FBE-\u0FC5\u0FC7-\u0FCC\u0FCE-\u0FDA\u1000-\u102C\u1031\u1038\u103B\u103C\u103F-\u1057\u105A-\u105D\u1061-\u1070\u1075-\u1081\u1083\u1084\u1087-\u108C\u108E-\u109C\u109E-\u10C5\u10C7\u10CD\u10D0-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1360-\u137C\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u167F\u1681-\u169A\u16A0-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1735\u1736\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17B6\u17BE-\u17C5\u17C7\u17C8\u17D4-\u17DA\u17DC\u17E0-\u17E9\u1810-\u1819\u1820-\u1877\u1880-\u1884\u1887-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1923-\u1926\u1929-\u192B\u1930\u1931\u1933-\u1938\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19DA\u1A00-\u1A16\u1A19\u1A1A\u1A1E-\u1A55\u1A57\u1A61\u1A63\u1A64\u1A6D-\u1A72\u1A80-\u1A89\u1A90-\u1A99\u1AA0-\u1AAD\u1B04-\u1B33\u1B35\u1B3B\u1B3D-\u1B41\u1B43-\u1B4B\u1B50-\u1B6A\u1B74-\u1B7C\u1B82-\u1BA1\u1BA6\u1BA7\u1BAA\u1BAE-\u1BE5\u1BE7\u1BEA-\u1BEC\u1BEE\u1BF2\u1BF3\u1BFC-\u1C2B\u1C34\u1C35\u1C3B-\u1C49\u1C4D-\u1C88\u1CC0-\u1CC7\u1CD3\u1CE1\u1CE9-\u1CEC\u1CEE-\u1CF3\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u200E\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u214F\u2160-\u2188\u2336-\u237A\u2395\u249C-\u24E9\u26AC\u2800-\u28FF\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D70\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u3005-\u3007\u3021-\u3029\u302E\u302F\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E\u3190-\u31BA\u31F0-\u321C\u3220-\u324F\u3260-\u327B\u327F-\u32B0\u32C0-\u32CB\u32D0-\u32FE\u3300-\u3376\u337B-\u33DD\u33E0-\u33FE\u3400-\u4DB5\u4E00-\u9FD5\uA000-\uA48C\uA4D0-\uA60C\uA610-\uA62B\uA640-\uA66E\uA680-\uA69D\uA6A0-\uA6EF\uA6F2-\uA6F7\uA722-\uA787\uA789-\uA7AE\uA7B0-\uA7B7\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA824\uA827\uA830-\uA837\uA840-\uA873\uA880-\uA8C3\uA8CE-\uA8D9\uA8F2-\uA8FD\uA900-\uA925\uA92E-\uA946\uA952\uA953\uA95F-\uA97C\uA983-\uA9B2\uA9B4\uA9B5\uA9BA\uA9BB\uA9BD-\uA9CD\uA9CF-\uA9D9\uA9DE-\uA9E4\uA9E6-\uA9FE\uAA00-\uAA28\uAA2F\uAA30\uAA33\uAA34\uAA40-\uAA42\uAA44-\uAA4B\uAA4D\uAA50-\uAA59\uAA5C-\uAA7B\uAA7D-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAAEB\uAAEE-\uAAF5\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB65\uAB70-\uABE4\uABE6\uABE7\uABE9-\uABEC\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uE000-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD00\uDD02\uDD07-\uDD33\uDD37-\uDD3F\uDD8D\uDD8E\uDDD0-\uDDFC\uDE80-\uDE9C\uDEA0-\uDED0\uDF00-\uDF23\uDF30-\uDF4A\uDF50-\uDF75\uDF80-\uDF9D\uDF9F-\uDFC3\uDFC8-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDD6F\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD804[\uDC00\uDC02-\uDC37\uDC47-\uDC4D\uDC66-\uDC6F\uDC82-\uDCB2\uDCB7\uDCB8\uDCBB-\uDCC1\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD03-\uDD26\uDD2C\uDD36-\uDD43\uDD50-\uDD72\uDD74-\uDD76\uDD82-\uDDB5\uDDBF-\uDDC9\uDDCD\uDDD0-\uDDDF\uDDE1-\uDDF4\uDE00-\uDE11\uDE13-\uDE2E\uDE32\uDE33\uDE35\uDE38-\uDE3D\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA9\uDEB0-\uDEDE\uDEE0-\uDEE2\uDEF0-\uDEF9\uDF02\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D-\uDF3F\uDF41-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF50\uDF57\uDF5D-\uDF63]|\uD805[\uDC00-\uDC37\uDC40\uDC41\uDC45\uDC47-\uDC59\uDC5B\uDC5D\uDC80-\uDCB2\uDCB9\uDCBB-\uDCBE\uDCC1\uDCC4-\uDCC7\uDCD0-\uDCD9\uDD80-\uDDB1\uDDB8-\uDDBB\uDDBE\uDDC1-\uDDDB\uDE00-\uDE32\uDE3B\uDE3C\uDE3E\uDE41-\uDE44\uDE50-\uDE59\uDE80-\uDEAA\uDEAC\uDEAE\uDEAF\uDEB6\uDEC0-\uDEC9\uDF00-\uDF19\uDF20\uDF21\uDF26\uDF30-\uDF3F]|\uD806[\uDCA0-\uDCF2\uDCFF\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC2F\uDC3E-\uDC45\uDC50-\uDC6C\uDC70-\uDC8F\uDCA9\uDCB1\uDCB4]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC70-\uDC74\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uDB80-\uDBBE\uDBC0-\uDBFE][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDE6E\uDE6F\uDED0-\uDEED\uDEF5\uDF00-\uDF2F\uDF37-\uDF45\uDF50-\uDF59\uDF5B-\uDF61\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50-\uDF7E\uDF93-\uDF9F\uDFE0]|\uD821[\uDC00-\uDFEC]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00\uDC01]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9C\uDC9F]|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDD66\uDD6A-\uDD72\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDDE8\uDF60-\uDF71]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEDA\uDEDC-\uDF14\uDF16-\uDF4E\uDF50-\uDF88\uDF8A-\uDFC2\uDFC4-\uDFCB]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85-\uDE8B]|\uD83C[\uDD10-\uDD2E\uDD30-\uDD69\uDD70-\uDDAC\uDDE6-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1]|\uD87E[\uDC00-\uDE1D]|[\uDBBF\uDBFF][\uDC00-\uDFFD]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/},{}],11:[function(t,e,u){e.exports=/\u202A/},{}],12:[function(t,e,u){e.exports=/\u2066/},{}],13:[function(t,e,u){e.exports=/\u202D/},{}],14:[function(t,e,u){e.exports=/[\u0300-\u036F\u0483-\u0489\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u0711\u0730-\u074A\u07A6-\u07B0\u07EB-\u07F3\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B\u08D4-\u08E1\u08E3-\u0902\u093A\u093C\u0941-\u0948\u094D\u0951-\u0957\u0962\u0963\u0981\u09BC\u09C1-\u09C4\u09CD\u09E2\u09E3\u0A01\u0A02\u0A3C\u0A41\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A70\u0A71\u0A75\u0A81\u0A82\u0ABC\u0AC1-\u0AC5\u0AC7\u0AC8\u0ACD\u0AE2\u0AE3\u0B01\u0B3C\u0B3F\u0B41-\u0B44\u0B4D\u0B56\u0B62\u0B63\u0B82\u0BC0\u0BCD\u0C00\u0C3E-\u0C40\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C62\u0C63\u0C81\u0CBC\u0CCC\u0CCD\u0CE2\u0CE3\u0D01\u0D41-\u0D44\u0D4D\u0D62\u0D63\u0DCA\u0DD2-\u0DD4\u0DD6\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0EB1\u0EB4-\u0EB9\u0EBB\u0EBC\u0EC8-\u0ECD\u0F18\u0F19\u0F35\u0F37\u0F39\u0F71-\u0F7E\u0F80-\u0F84\u0F86\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102D-\u1030\u1032-\u1037\u1039\u103A\u103D\u103E\u1058\u1059\u105E-\u1060\u1071-\u1074\u1082\u1085\u1086\u108D\u109D\u135D-\u135F\u1712-\u1714\u1732-\u1734\u1752\u1753\u1772\u1773\u17B4\u17B5\u17B7-\u17BD\u17C6\u17C9-\u17D3\u17DD\u180B-\u180D\u1885\u1886\u18A9\u1920-\u1922\u1927\u1928\u1932\u1939-\u193B\u1A17\u1A18\u1A1B\u1A56\u1A58-\u1A5E\u1A60\u1A62\u1A65-\u1A6C\u1A73-\u1A7C\u1A7F\u1AB0-\u1ABE\u1B00-\u1B03\u1B34\u1B36-\u1B3A\u1B3C\u1B42\u1B6B-\u1B73\u1B80\u1B81\u1BA2-\u1BA5\u1BA8\u1BA9\u1BAB-\u1BAD\u1BE6\u1BE8\u1BE9\u1BED\u1BEF-\u1BF1\u1C2C-\u1C33\u1C36\u1C37\u1CD0-\u1CD2\u1CD4-\u1CE0\u1CE2-\u1CE8\u1CED\u1CF4\u1CF8\u1CF9\u1DC0-\u1DF5\u1DFB-\u1DFF\u20D0-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302D\u3099\u309A\uA66F-\uA672\uA674-\uA67D\uA69E\uA69F\uA6F0\uA6F1\uA802\uA806\uA80B\uA825\uA826\uA8C4\uA8C5\uA8E0-\uA8F1\uA926-\uA92D\uA947-\uA951\uA980-\uA982\uA9B3\uA9B6-\uA9B9\uA9BC\uA9E5\uAA29-\uAA2E\uAA31\uAA32\uAA35\uAA36\uAA43\uAA4C\uAA7C\uAAB0\uAAB2-\uAAB4\uAAB7\uAAB8\uAABE\uAABF\uAAC1\uAAEC\uAAED\uAAF6\uABE5\uABE8\uABED\uFB1E\uFE00-\uFE0F\uFE20-\uFE2F]|\uD800[\uDDFD\uDEE0\uDF76-\uDF7A]|\uD802[\uDE01-\uDE03\uDE05\uDE06\uDE0C-\uDE0F\uDE38-\uDE3A\uDE3F\uDEE5\uDEE6]|\uD804[\uDC01\uDC38-\uDC46\uDC7F-\uDC81\uDCB3-\uDCB6\uDCB9\uDCBA\uDD00-\uDD02\uDD27-\uDD2B\uDD2D-\uDD34\uDD73\uDD80\uDD81\uDDB6-\uDDBE\uDDCA-\uDDCC\uDE2F-\uDE31\uDE34\uDE36\uDE37\uDE3E\uDEDF\uDEE3-\uDEEA\uDF00\uDF01\uDF3C\uDF40\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC38-\uDC3F\uDC42-\uDC44\uDC46\uDCB3-\uDCB8\uDCBA\uDCBF\uDCC0\uDCC2\uDCC3\uDDB2-\uDDB5\uDDBC\uDDBD\uDDBF\uDDC0\uDDDC\uDDDD\uDE33-\uDE3A\uDE3D\uDE3F\uDE40\uDEAB\uDEAD\uDEB0-\uDEB5\uDEB7\uDF1D-\uDF1F\uDF22-\uDF25\uDF27-\uDF2B]|\uD807[\uDC30-\uDC36\uDC38-\uDC3D\uDC92-\uDCA7\uDCAA-\uDCB0\uDCB2\uDCB3\uDCB5\uDCB6]|\uD81A[\uDEF0-\uDEF4\uDF30-\uDF36]|\uD81B[\uDF8F-\uDF92]|\uD82F[\uDC9D\uDC9E]|\uD834[\uDD67-\uDD69\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD836[\uDE00-\uDE36\uDE3B-\uDE6C\uDE75\uDE84\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDCD0-\uDCD6\uDD44-\uDD4A]|\uDB40[\uDD00-\uDDEF]/},{}],15:[function(t,e,u){e.exports=/[!"&-\*;-@\[-`\{-~\xA1\xA6-\xA9\xAB\xAC\xAE\xAF\xB4\xB6-\xB8\xBB-\xBF\xD7\xF7\u02B9\u02BA\u02C2-\u02CF\u02D2-\u02DF\u02E5-\u02ED\u02EF-\u02FF\u0374\u0375\u037E\u0384\u0385\u0387\u03F6\u058A\u058D\u058E\u0606\u0607\u060E\u060F\u06DE\u06E9\u07F6-\u07F9\u0BF3-\u0BF8\u0BFA\u0C78-\u0C7E\u0F3A-\u0F3D\u1390-\u1399\u1400\u169B\u169C\u17F0-\u17F9\u1800-\u180A\u1940\u1944\u1945\u19DE-\u19FF\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD\u1FFE\u2010-\u2027\u2035-\u2043\u2045-\u205E\u207C-\u207E\u208C-\u208E\u2100\u2101\u2103-\u2106\u2108\u2109\u2114\u2116-\u2118\u211E-\u2123\u2125\u2127\u2129\u213A\u213B\u2140-\u2144\u214A-\u214D\u2150-\u215F\u2189-\u218B\u2190-\u2211\u2214-\u2335\u237B-\u2394\u2396-\u23FE\u2400-\u2426\u2440-\u244A\u2460-\u2487\u24EA-\u26AB\u26AD-\u27FF\u2900-\u2B73\u2B76-\u2B95\u2B98-\u2BB9\u2BBD-\u2BC8\u2BCA-\u2BD1\u2BEC-\u2BEF\u2CE5-\u2CEA\u2CF9-\u2CFF\u2E00-\u2E44\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFB\u3001-\u3004\u3008-\u3020\u3030\u3036\u3037\u303D-\u303F\u309B\u309C\u30A0\u30FB\u31C0-\u31E3\u321D\u321E\u3250-\u325F\u327C-\u327E\u32B1-\u32BF\u32CC-\u32CF\u3377-\u337A\u33DE\u33DF\u33FF\u4DC0-\u4DFF\uA490-\uA4C6\uA60D-\uA60F\uA673\uA67E\uA67F\uA700-\uA721\uA788\uA828-\uA82B\uA874-\uA877\uFD3E\uFD3F\uFDFD\uFE10-\uFE19\uFE30-\uFE4F\uFE51\uFE54\uFE56-\uFE5E\uFE60\uFE61\uFE64-\uFE66\uFE68\uFE6B\uFF01\uFF02\uFF06-\uFF0A\uFF1B-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\uFFE2-\uFFE4\uFFE8-\uFFEE\uFFF9-\uFFFD]|\uD800[\uDD01\uDD40-\uDD8C\uDD90-\uDD9B\uDDA0]|\uD802[\uDD1F\uDF39-\uDF3F]|\uD804[\uDC52-\uDC65]|\uD805[\uDE60-\uDE6C]|\uD834[\uDE00-\uDE41\uDE45\uDF00-\uDF56]|\uD835[\uDEDB\uDF15\uDF4F\uDF89\uDFC3]|\uD83B[\uDEF0\uDEF1]|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD0B\uDD0C\uDD6A\uDD6B\uDF00-\uDFFF]|\uD83D[\uDC00-\uDED2\uDEE0-\uDEEC\uDEF0-\uDEF6\uDF00-\uDF73\uDF80-\uDFD4]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDD10-\uDD1E\uDD20-\uDD27\uDD30\uDD33-\uDD3E\uDD40-\uDD4B\uDD50-\uDD5E\uDD80-\uDD91\uDDC0]/},{}],16:[function(t,e,u){e.exports=/[\n\r\x1C-\x1E\x85\u2029]/},{}],17:[function(t,e,u){e.exports=/\u202C/},{}],18:[function(t,e,u){e.exports=/\u2069/},{}],19:[function(t,e,u){e.exports=/[\u05BE\u05C0\u05C3\u05C6\u05D0-\u05EA\u05F0-\u05F4\u07C0-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0830-\u083E\u0840-\u0858\u085E\u200F\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFB4F]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC57-\uDC9E\uDCA7-\uDCAF\uDCE0-\uDCF2\uDCF4\uDCF5\uDCFB-\uDD1B\uDD20-\uDD39\uDD3F\uDD80-\uDDB7\uDDBC-\uDDCF\uDDD2-\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE40-\uDE47\uDE50-\uDE58\uDE60-\uDE9F\uDEC0-\uDEE4\uDEEB-\uDEF6\uDF00-\uDF35\uDF40-\uDF55\uDF58-\uDF72\uDF78-\uDF91\uDF99-\uDF9C\uDFA9-\uDFAF]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2\uDCFA-\uDCFF]|\uD83A[\uDC00-\uDCC4\uDCC7-\uDCCF\uDD00-\uDD43\uDD50-\uDD59\uDD5E\uDD5F]/},{}],20:[function(t,e,u){e.exports=/\u202B/},{}],21:[function(t,e,u){e.exports=/\u2067/},{}],22:[function(t,e,u){e.exports=/\u202E/},{}],23:[function(t,e,u){e.exports=/[\t\x0B\x1F]/},{}],24:[function(t,e,u){e.exports=/[\f \u1680\u2000-\u200A\u2028\u205F\u3000]/},{}],25:[function(t,e,u){"use strict";var r=t("unicode-9.0.0/Bidi_Class/Arabic_Letter/regex"),n=t("unicode-9.0.0/Bidi_Class/Arabic_Number/regex"),i=t("unicode-9.0.0/Bidi_Class/Boundary_Neutral/regex"),o=t("unicode-9.0.0/Bidi_Class/Common_Separator/regex"),a=t("unicode-9.0.0/Bidi_Class/European_Number/regex"),s=t("unicode-9.0.0/Bidi_Class/European_Separator/regex"),f=t("unicode-9.0.0/Bidi_Class/European_Terminator/regex"),c=t("unicode-9.0.0/Bidi_Class/First_Strong_Isolate/regex"),D=t("unicode-9.0.0/Bidi_Class/Left_To_Right/regex"),l=t("unicode-9.0.0/Bidi_Class/Left_To_Right_Embedding/regex"),h=t("unicode-9.0.0/Bidi_Class/Left_To_Right_Isolate/regex"),p=t("unicode-9.0.0/Bidi_Class/Left_To_Right_Override/regex"),d=t("unicode-9.0.0/Bidi_Class/Nonspacing_Mark/regex"),_=t("unicode-9.0.0/Bidi_Class/Other_Neutral/regex"),v=t("unicode-9.0.0/Bidi_Class/Paragraph_Separator/regex"),F=t("unicode-9.0.0/Bidi_Class/Pop_Directional_Format/regex"),E=t("unicode-9.0.0/Bidi_Class/Pop_Directional_Isolate/regex"),C=t("unicode-9.0.0/Bidi_Class/Right_To_Left/regex"),A=t("unicode-9.0.0/Bidi_Class/Right_To_Left_Embedding/regex"),y=t("unicode-9.0.0/Bidi_Class/Right_To_Left_Isolate/regex"),B=t("unicode-9.0.0/Bidi_Class/Right_To_Left_Override/regex"),g=t("unicode-9.0.0/Bidi_Class/Segment_Separator/regex"),m=t("unicode-9.0.0/Bidi_Class/White_Space/regex"),S=t("punycode"),w={AL:r,AN:n,BN:i,CS:o,EN:a,ES:s,ET:f,FSI:c,L:D,LRE:l,LRI:h,LRO:p,NSM:d,ON:_,B:v,PDF:F,PDI:E,R:C,RLE:A,RLI:y,RLO:B,S:g,WS:m};e.exports=function(t){var e,u=S.ucs2.encode([t]);for(e in w)if(!0===w[e].test(u))return e}},{punycode:1,"unicode-9.0.0/Bidi_Class/Arabic_Letter/regex":2,"unicode-9.0.0/Bidi_Class/Arabic_Number/regex":3,"unicode-9.0.0/Bidi_Class/Boundary_Neutral/regex":4,"unicode-9.0.0/Bidi_Class/Common_Separator/regex":5,"unicode-9.0.0/Bidi_Class/European_Number/regex":6,"unicode-9.0.0/Bidi_Class/European_Separator/regex":7,"unicode-9.0.0/Bidi_Class/European_Terminator/regex":8,"unicode-9.0.0/Bidi_Class/First_Strong_Isolate/regex":9,"unicode-9.0.0/Bidi_Class/Left_To_Right/regex":10,"unicode-9.0.0/Bidi_Class/Left_To_Right_Embedding/regex":11,"unicode-9.0.0/Bidi_Class/Left_To_Right_Isolate/regex":12,"unicode-9.0.0/Bidi_Class/Left_To_Right_Override/regex":13,"unicode-9.0.0/Bidi_Class/Nonspacing_Mark/regex":14,"unicode-9.0.0/Bidi_Class/Other_Neutral/regex":15,"unicode-9.0.0/Bidi_Class/Paragraph_Separator/regex":16,"unicode-9.0.0/Bidi_Class/Pop_Directional_Format/regex":17,"unicode-9.0.0/Bidi_Class/Pop_Directional_Isolate/regex":18,"unicode-9.0.0/Bidi_Class/Right_To_Left/regex":19,"unicode-9.0.0/Bidi_Class/Right_To_Left_Embedding/regex":20,"unicode-9.0.0/Bidi_Class/Right_To_Left_Isolate/regex":21,"unicode-9.0.0/Bidi_Class/Right_To_Left_Override/regex":22,"unicode-9.0.0/Bidi_Class/Segment_Separator/regex":23,"unicode-9.0.0/Bidi_Class/White_Space/regex":24}]},{},[25])(25)})}).call(e,u(5))},function(t,e,u){(function(t,r){var n;!function(i){function o(t){throw new RangeError(x[t])}function a(t,e){for(var u=t.length,r=[];u--;)r[u]=e(t[u]);return r}function s(t,e){var u=t.split("@"),r="";return u.length>1&&(r=u[0]+"@",t=u[1]),r+a((t=t.replace(I,".")).split("."),e).join(".")}function f(t){for(var e,u,r=[],n=0,i=t.length;n<i;)(e=t.charCodeAt(n++))>=55296&&e<=56319&&n<i?56320==(64512&(u=t.charCodeAt(n++)))?r.push(((1023&e)<<10)+(1023&u)+65536):(r.push(e),n--):r.push(e);return r}function c(t){return a(t,function(t){var e="";return t>65535&&(e+=z((t-=65536)>>>10&1023|55296),t=56320|1023&t),e+=z(t)}).join("")}function D(t){return t-48<10?t-22:t-65<26?t-65:t-97<26?t-97:E}function l(t,e){return t+22+75*(t<26)-((0!=e)<<5)}function h(t,e,u){var r=0;for(t=u?O(t/B):t>>1,t+=O(t/e);t>L*A>>1;r+=E)t=O(t/L);return O(r+(L+1)*t/(t+y))}function p(t){var e,u,r,n,i,a,s,f,l,p,d=[],_=t.length,v=0,y=m,B=g;for((u=t.lastIndexOf(S))<0&&(u=0),r=0;r<u;++r)t.charCodeAt(r)>=128&&o("not-basic"),d.push(t.charCodeAt(r));for(n=u>0?u+1:0;n<_;){for(i=v,a=1,s=E;n>=_&&o("invalid-input"),((f=D(t.charCodeAt(n++)))>=E||f>O((F-v)/a))&&o("overflow"),v+=f*a,l=s<=B?C:s>=B+A?A:s-B,!(f<l);s+=E)a>O(F/(p=E-l))&&o("overflow"),a*=p;B=h(v-i,e=d.length+1,0==i),O(v/e)>F-y&&o("overflow"),y+=O(v/e),v%=e,d.splice(v++,0,y)}return c(d)}function d(t){var e,u,r,n,i,a,s,c,D,p,d,_,v,y,B,w=[];for(_=(t=f(t)).length,e=m,u=0,i=g,a=0;a<_;++a)(d=t[a])<128&&w.push(z(d));for(r=n=w.length,n&&w.push(S);r<_;){for(s=F,a=0;a<_;++a)(d=t[a])>=e&&d<s&&(s=d);for(s-e>O((F-u)/(v=r+1))&&o("overflow"),u+=(s-e)*v,e=s,a=0;a<_;++a)if((d=t[a])<e&&++u>F&&o("overflow"),d==e){for(c=u,D=E;p=D<=i?C:D>=i+A?A:D-i,!(c<p);D+=E)B=c-p,y=E-p,w.push(z(l(p+B%y,0))),c=O(B/y);w.push(z(l(c,0))),i=h(u,v,r==n),u=0,++r}++u,++e}return w.join("")}"object"==typeof e&&e&&e.nodeType,"object"==typeof t&&t&&t.nodeType;var _="object"==typeof r&&r;var v,F=2147483647,E=36,C=1,A=26,y=38,B=700,g=72,m=128,S="-",w=/^xn--/,b=/[^\x20-\x7E]/,I=/[\x2E\u3002\uFF0E\uFF61]/g,x={overflow:"Overflow: input needs wider integers to process","not-basic":"Illegal input >= 0x80 (not a basic code point)","invalid-input":"Invalid input"},L=E-C,O=Math.floor,z=String.fromCharCode;v={version:"1.4.1",ucs2:{decode:f,encode:c},decode:p,encode:d,toASCII:function(t){return s(t,function(t){return b.test(t)?"xn--"+d(t):t})},toUnicode:function(t){return s(t,function(t){return w.test(t)?p(t.slice(4).toLowerCase()):t})}},void 0!==(n=function(){return v}.call(e,u,e,t))&&(t.exports=n)}()}).call(e,u(48)(t),u(5))},function(t,e){t.exports=function(t){return t.webpackPolyfill||(t.deprecate=function(){},t.paths=[],t.children||(t.children=[]),Object.defineProperty(t,"loaded",{enumerable:!0,get:function(){return t.l}}),Object.defineProperty(t,"id",{enumerable:!0,get:function(){return t.i}}),t.webpackPolyfill=1),t}}])});/*
Script: RectanglePacker.js
	An algorithm implementation in JavaScript for rectangle packing.

Author:
	Iván Montes <drslump@drslump.biz>, <http://blog.netxus.es>

License:
	LGPL - Lesser General Public License

Credits:
	- Algorithm based on <http://www.blackpawn.com/texts/lightmaps/default.html>
*/

/*
	Class: NETXUS.RectanglePacker
	A class that finds an 'efficient' position for a rectangle inside another rectangle
	without overlapping the space already taken.
	
	Algorithm based on <http://www.blackpawn.com/texts/lightmaps/default.html>
	
	It uses a binary tree to partition the space of the parent rectangle and allocate the 
	passed rectangles by dividing the partitions into filled and empty.
*/


// Create a NETXUS namespace object if it doesn't exists
if (typeof NETXUS === 'undefined')
	var NETXUS = function() {};		
	

/*	
	Constructor: NETXUS.RectanglePacker
	Initializes the object with the given maximum dimensions
	
	Parameters:
	
		width - The containing rectangle maximum width as integer
		height - The containing rectangle maximum height as integer
		
*/	
NETXUS.RectanglePacker = function ( width, height ) {
	
	this.root = {};

	// initialize
	this.reset( width, height );	
}


/*
	Resets the object to its initial state by initializing the internal variables

	Parameters:
	
		width - The containing rectangle maximum width as integer
		height - The containing rectangle maximum height as integer
*/
NETXUS.RectanglePacker.prototype.reset = function ( width, height ) {
	this.root.x = 0;
	this.root.y = 0;
	this.root.w = width;
	this.root.h = height;
	delete this.root.lft;
	delete this.root.rgt;
	
	this.usedWidth = 0;
	this.usedHeight = 0;	
}
	

/*
	Returns the actual used dimensions of the containing rectangle.
	
	Returns:
	
		A object composed of the properties: 'w' for width and 'h' for height. 
*/
NETXUS.RectanglePacker.prototype.getDimensions = function () {
	return { w: this.usedWidth, h: this.usedHeight };	
}
	
	
/*
 	Finds a suitable place for the given rectangle
 	
	Parameters:
	
		w - The rectangle width as integer.
		h - The rectangle height as integer.
		
	Returns:
	
		If there is room for the rectangle then returns the coordinates as an object 
		composed of 'x' and 'y' properties. 
		If it doesn't fit returns null
*/  	
NETXUS.RectanglePacker.prototype.findCoords = function ( w, h ) {
	
	// private function to traverse the node tree by recursion
	function recursiveFindCoords ( node, w, h ) {

		// private function to clone a node coords and size
		function cloneNode ( node ) {
			return {
				x: node.x,
				y: node.y,
				w: node.w,
				h: node.h	
			};
		}		
		
		// if we are not at a leaf then go deeper
		if ( node.lft ) {
			// check first the left branch if not found then go by the right
			var coords = recursiveFindCoords( node.lft, w, h );
			return coords ? coords : recursiveFindCoords( node.rgt, w, h );	
		}
		else
		{
			// if already used or it's too big then return
			if ( node.used || w > node.w || h > node.h )
				return null;
				
			// if it fits perfectly then use this gap
			if ( w == node.w && h == node.h ) {
				node.used = true;
				return { x: node.x, y: node.y };
			}
			
			// initialize the left and right leafs by clonning the current one
			node.lft = cloneNode( node );
			node.rgt = cloneNode( node );
			
			// checks if we partition in vertical or horizontal
			if ( node.w - w > node.h - h ) {
				node.lft.w = w;
				node.rgt.x = node.x + w;
				node.rgt.w = node.w - w;	
			} else {
				node.lft.h = h;
				node.rgt.y = node.y + h;
				node.rgt.h = node.h - h;							
			}
			
			return recursiveFindCoords( node.lft, w, h );		
		}
	}
		
	// perform the search
	var coords = recursiveFindCoords( this.root, w, h );
	// if fitted then recalculate the used dimensions
	if (coords) {
		if ( this.usedWidth < coords.x + w )
			this.usedWidth = coords.x + w;
		if ( this.usedHeight < coords.y + h )
			this.usedHeight = coords.y + h;
	}
	return coords;
}

function UnionFind(count) {
	this.roots = new Array(count);
	this.ranks = new Array(count);
	
	for(var i=0; i<count; ++i) {
		this.roots[i] = i;
		this.ranks[i] = 0;
	}
}

UnionFind.prototype.find = function(x) {
	var x0 = x;
	var roots = this.roots;
	while(roots[x] != x)  x = roots[x];
  
	while(roots[x0] != x) {
		var y = roots[x0];
		roots[x0] = x;
		x0 = y;
	} 
	return x;
}

UnionFind.prototype.link = function(x, y) {
	var xr = this.find(x), yr = this.find(y);
	if(xr == yr)  return;

	var ranks = this.ranks, roots = this.roots, xd = ranks[xr], yd = ranks[yr];
 
	if     (xd < yd) {  roots[xr] = yr;  }
	else if(yd < xd) {  roots[yr] = xr;  }
	else {  roots[yr] = xr;  ++ranks[xr];  }
}