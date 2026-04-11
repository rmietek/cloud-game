

	
function packet_get()
{
this.d =  new DataView(new ArrayBuffer(0), 0);;
this.index = 0;



	this.set_buffer = function(buf)
	{
		this.d =  new DataView(buf, 0);
		this.index = 0;
		return this; 
	}

    this.g_int8 = function()
	{
	  return this.d.getInt8(this.index++);
	}
	this.g_uint8 = function()
	{
	  return this.d.getUint8(this.index++);
	}
	
	this.g_int32 = function()
	{
	  this.index+=4;
	  return this.d.getInt32(this.index-4);
	}
	this.g_uint32 = function()
	{
	  this.index+=4;
	  return this.d.getUint32(this.index-4);
	}
	
	
	this.g_int16 = function()
	{
	  this.index+=2;
	  return this.d.getInt16(this.index-2);
	}
	this.g_uint16 = function()
	{
	  this.index+=2;
	  return this.d.getUint16(this.index-2);
	}
	
	this.g_float = function()
	{
	  this.index+=4;
	  return this.d.getFloat32(this.index-4);
	}
		
	this.g_string = function()
	{
	  var str = "";
	  var l = this.d.getUint8(this.index);
	  this.index++;
	  for (var i = l;i--;)
	  {
		str += String.fromCharCode(this.d.getUint8(this.index));
		this.index++;
	  }
	  return str;
	}
	this.g_string16 = function()
	{
	  var str = "";
	  var l = this.d.getUint8(this.index);
	  this.index++;
	  for (var i = l;i--;)
	  {
		str += String.fromCharCode(this.d.getUint16(this.index));
		this.index+=2;
	  }
	  return str;
	}
	this.g_int8_arr = function()
	{
	  var tab = [];
	  var l = this.g_uint16();
	  for (var i = l;i--;)
	  {
		tab[i] = this.g_uint8();
	  }
	  return tab;
	}
	
	this.g_int16_arr = function()
	{
	  var tab = [];
	  var l = this.g_uint16();
	  for (var i = l;i--;)
	  {
		tab[i] = this.g_uint16();
	  }
	  return tab;
	}
	
	this.g_int32_arr = function()
	{
	  var tab = [];
	  var l = this.g_uint16();
	  for (var i = l;i--;)
	  {
		tab[i] = this.g_uint32();
	  }
	  return tab;
	}
	
	
	
	this.g_string_arr = function()
	{
	  var tab = [];
	  var l = this.g_uint16();
	  for (var i = l;i--;)
	  {
		tab[i] = this.g_string();
	  }
	  return tab;
	}
	
	
	this.g_length8   = this.g_uint8;
	this.g_length16  = this.g_uint16;
	
	
}
 
function packet_set(size)
{
	
this.buffor = new ArrayBuffer(size);
this.int8 =  new Uint8Array(this.buffor);
this.DV = new DataView(this.buffor, 0);

this.index = 1;
this.global_index = 0;
this.global_c = 0;

    this.new_type   =function (i)
	{
		this.int8[0]++;
		this.int8[this.index] = i;
		this.index++;
	}
	//////////////////////////////////// uniq pack
	this.get_uniq_buf   =function ()
	{
		var b = this.buffor.slice(0,this.index);
		this.index =  this.global_index;
		this.int8[0] = this.global_c;
		return b;
	}
	
	this.clear_uniq_buf   =function ()
	{
		this.index =   this.global_index;
		this.int8[0] = this.global_c;
	}
	
	this.end_global   =function ()
	{
		 this.global_index = this.index;
		 this.global_c = this.int8[0];
	}
	
    this.clear  =function ()
	{
		this.index = 1;
		this.int8[0] = 0;
		this.global_index = 1;
		this.global_c = 0;
		
	}
	//////////////////////////////////// uniq pack
	this.get_buf   =function ()
	{
		var b = this.buffor.slice(0,this.index);
		this.index = 1;
		this.int8[0] = 0;
		return b;
	}

	this.s_int8   =function (val)
	{
		
		this.int8[this.index] = val;
		this.index++;
	}
	
	this.s_int32 = function(val)
	{
	
	  this.DV.setInt32(this.index,val);
	  this.index+=4;
	}
	this.s_uint32 = this.s_int32;
	
	
	
	this.s_int16   =function (val)
	{
		
		this.int8[this.index] =  val>>8 ;
		this.int8[this.index+1] =  val&0xff;
		this.index+=2;
	}
		this.s_uint8  = this.s_int8;
	
		this.s_uint16 = this.s_int16;
		
		
	this.s_length8 = this.s_int8;
	this.s_length16 = this.s_int16;
	
	this.s_int8_arr   =function (ptr,siz)
	{
		if (!siz) siz = ptr.length;
		this.int8[this.index]   = siz>>8 ;
		this.int8[this.index+1] = siz&0xff ;
		this.index+=2;
		for (var u = siz;u--;)
		{
			this.int8[this.index] = ptr[u];
			this.index++;
		}
	}
	this.s_int16_arr   =function (ptr,siz)
	{
		if (!siz) siz = ptr.length;
		this.int8[this.index]   = siz>>8 ;
		this.int8[this.index+1] = siz&0xff ;
		this.index+=2;
		for (var u = siz;u--;)
		{
			this.s_uint16(ptr[u]);
		}
	}
	
	this.s_int32_arr   =function (ptr,siz)
	{
		if (!siz) siz = ptr.length;
		this.int8[this.index]   = siz>>8 ;
		this.int8[this.index+1] = siz&0xff ;
		this.index+=2;
		for (var u = siz;u--;)
		{
			this.s_uint32(ptr[u]);
		}
	}
	
	
	this.s_string_arr   =function (ptr,siz)
	{
		this.int8[this.index]   = siz>>8 ;
		this.int8[this.index+1] = siz&0xff ;
		this.index+=2;
		for (var u = siz;u--;)
		{
			this.s_string(ptr[u]);
		}
	}
	
	
	
	this.s_string   =function (val)
	{
		var sl = val.length;
        this.int8[this.index]  = sl;
		this.index++;
		for (var i = 0;i<sl;i++)
		{
		this.int8[this.index] = val.charCodeAt(i);	
		this.index++;	
		}
		
	}
	
	this.s_string16   =function (val)
	{
		var sl = val.length;
        this.int8[this.index]  = sl;
		this.index++;
		for (var i = 0;i<sl;i++)
		{
		this.DV.setInt16(this.index,val.charCodeAt(i));
		this.index+=2;	
		}
		
	}
	
	
	this.s_float = function (val)
	{
        this.DV.setFloat32(this.index,val);
		this.index+=4;
	}
}
 if (exports)
 {
	exports.packet_set = packet_set;
	exports.packet_get = packet_get;
 }