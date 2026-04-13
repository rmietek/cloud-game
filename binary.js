// ─── SERIALIZACJA PAKIETÓW BINARNYCH ─────────────────────────────────────────
// Ten plik definiuje dwie klasy do komunikacji sieciowej przez WebSocket:
//
//   packet_get — czytanie danych z odebranego pakietu binarnego (deserializacja)
//   packet_set — budowanie pakietu binarnego do wysłania (serializacja)
//
// Dlaczego binarnie a nie JSON?
//   Pakiety binarne są wielokrotnie mniejsze od JSON — ważne w grach czasu rzeczywistego
//   gdzie co klatkę wysyłane są pozycje, strzały, zdarzenia itd.
//
// Format pakietu:
//   [0]      — liczba typów wiadomości w pakiecie (ile komend zawiera ten pakiet)
//   [1]      — typ pierwszej komendy (np. 1 = ruch gracza, 2 = strzał itd.)
//   [2...]   — dane komendy (liczby, stringi, tablice)
//   [n]      — typ następnej komendy
//   [n+1...] — dane następnej komendy
// ─────────────────────────────────────────────────────────────────────────────


// ─── packet_get — ODCZYT PAKIETU ─────────────────────────────────────────────
// Używane po stronie odbiorcy (serwer czyta pakiet od gracza lub odwrotnie).
// Wewnętrznie trzyma wskaźnik (index) który przesuwa się po buforze
// wraz z każdym odczytem — kolejne wywołania g_* czytają kolejne bajty.
// ─────────────────────────────────────────────────────────────────────────────
function packet_get()
{
this.d =  new DataView(new ArrayBuffer(0), 0);
this.index = 0;

	// Ładuje nowy bufor do odczytu (np. dane otrzymane przez WebSocket).
	// Resetuje wskaźnik na początek.
	this.set_buffer = function(buf)
	{
		this.d =  new DataView(buf, 0);
		this.index = 0;
		return this;
	}

	// Odczyt liczb całkowitych — int8/uint8 = 1 bajt, int16/uint16 = 2 bajty, int32/uint32 = 4 bajty
	// int = może być ujemny, uint = tylko nieujemne (0 i więcej)
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

	// Odczyt liczby zmiennoprzecinkowej (float) — 4 bajty, np. pozycja X/Y gracza
	this.g_float = function()
	{
	  this.index+=4;
	  return this.d.getFloat32(this.index-4);
	}

	// Odczyt stringa — pierwszy bajt to długość tekstu, potem kolejne bajty to znaki (ASCII)
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
	// Wersja 16-bitowa — każdy znak zajmuje 2 bajty zamiast 1 (obsługuje znaki spoza ASCII)
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

	// Odczyt tablic — pierwszy uint16 to liczba elementów, potem kolejne elementy
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

	// Aliasy dla czytelności — g_length8/16 to po prostu odczyt liczby (długości tablicy/stringa)
	this.g_length8   = this.g_uint8;
	this.g_length16  = this.g_uint16;
}


// ─── packet_set — BUDOWANIE PAKIETU ──────────────────────────────────────────
// Używane po stronie nadawcy do skonstruowania pakietu przed wysłaniem.
// Alokuje bufor o podanym rozmiarze i wypełnia go kolejnymi wartościami.
// Na końcu get_buf() zwraca gotowy bufor do wysłania przez WebSocket.
// ─────────────────────────────────────────────────────────────────────────────
function packet_set(size)
{
this.buffor = new ArrayBuffer(size); // Bufor o z góry określonym rozmiarze
this.int8 =  new Uint8Array(this.buffor); // Widok bajtowy — do zapisywania pojedynczych bajtów
this.DV = new DataView(this.buffor, 0);   // DataView — do zapisywania liczb wielobajtowych

this.index = 1;          // index=1 bo bajt [0] jest zarezerwowany na liczbę komend w pakiecie
this.global_index = 0;
this.global_c = 0;

	// Dodaje nowy typ komendy do pakietu.
	// Bajt [0] (licznik komend) jest inkrementowany,
	// następnie wpisywany jest numer komendy.
    this.new_type = function(i)
	{
		this.int8[0]++;       // zwiększ licznik komend
		this.int8[this.index] = i; // wpisz numer komendy
		this.index++;
	}

	// ─── Tryb "uniq" — pakiet z punktem przywracania ─────────────────────────
	// end_global() zapisuje aktualną pozycję jako punkt kontrolny.
	// get_uniq_buf() zwraca dane od punktu kontrolnego do teraz i cofa wskaźnik.
	// Używane gdy chcemy wielokrotnie budować różne "ogonki" do tego samego początku pakietu.

	// Zwraca bufor od początku do aktualnej pozycji i cofa wskaźnik do punktu kontrolnego
	this.get_uniq_buf = function()
	{
		var b = this.buffor.slice(0,this.index);
		this.index =  this.global_index;
		this.int8[0] = this.global_c;
		return b;
	}

	// Cofa wskaźnik do punktu kontrolnego bez zwracania bufora
	this.clear_uniq_buf = function()
	{
		this.index =   this.global_index;
		this.int8[0] = this.global_c;
	}

	// Zapisuje aktualną pozycję jako punkt kontrolny
	this.end_global = function()
	{
		 this.global_index = this.index;
		 this.global_c = this.int8[0];
	}

	// Resetuje pakiet do stanu początkowego (pusty pakiet, gotowy do ponownego użycia)
    this.clear = function()
	{
		this.index = 1;
		this.int8[0] = 0;
		this.global_index = 1;
		this.global_c = 0;
	}

	// Zwraca gotowy bufor do wysłania i resetuje pakiet na puste
	this.get_buf = function()
	{
		var b = this.buffor.slice(0,this.index);
		this.index = 1;
		this.int8[0] = 0;
		return b;
	}

	// Zapis liczb całkowitych — odpowiedniki g_* z packet_get
	this.s_int8 = function(val)
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

	// s_int16 zapisuje ręcznie 2 bajty (big-endian: starszy bajt pierwszy)
	this.s_int16 = function(val)
	{
		this.int8[this.index] =  val>>8;    // starszy bajt
		this.int8[this.index+1] =  val&0xff; // młodszy bajt
		this.index+=2;
	}
	this.s_uint8  = this.s_int8;
	this.s_uint16 = this.s_int16;
	this.s_length8 = this.s_int8;
	this.s_length16 = this.s_int16;

	// Zapis tablic — najpierw 2 bajty długości, potem kolejne elementy
	this.s_int8_arr = function(ptr,siz)
	{
		if (!siz) siz = ptr.length;
		this.int8[this.index]   = siz>>8;
		this.int8[this.index+1] = siz&0xff;
		this.index+=2;
		for (var u = siz;u--;)
		{
			this.int8[this.index] = ptr[u];
			this.index++;
		}
	}
	this.s_int16_arr = function(ptr,siz)
	{
		if (!siz) siz = ptr.length;
		this.int8[this.index]   = siz>>8;
		this.int8[this.index+1] = siz&0xff;
		this.index+=2;
		for (var u = siz;u--;)
		{
			this.s_uint16(ptr[u]);
		}
	}

	this.s_int32_arr = function(ptr,siz)
	{
		if (!siz) siz = ptr.length;
		this.int8[this.index]   = siz>>8;
		this.int8[this.index+1] = siz&0xff;
		this.index+=2;
		for (var u = siz;u--;)
		{
			this.s_uint32(ptr[u]);
		}
	}

	this.s_string_arr = function(ptr,siz)
	{
		this.int8[this.index]   = siz>>8;
		this.int8[this.index+1] = siz&0xff;
		this.index+=2;
		for (var u = siz;u--;)
		{
			this.s_string(ptr[u]);
		}
	}

	// Zapis stringa — pierwszy bajt to długość, potem znaki jako bajty (ASCII)
	this.s_string = function(val)
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

	// Wersja 16-bitowa — każdy znak zajmuje 2 bajty (obsługuje znaki spoza ASCII)
	this.s_string16 = function(val)
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

	// Zapis liczby zmiennoprzecinkowej — 4 bajty, np. pozycja X/Y gracza
	this.s_float = function(val)
	{
        this.DV.setFloat32(this.index,val);
		this.index+=4;
	}
}

// Eksport dla Node.js (serwer) — w przeglądarce te funkcje są globalne
if (exports)
{
	exports.packet_set = packet_set;
	exports.packet_get = packet_get;
}
