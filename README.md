# Fordon RP — bot /ban (discord.js)

## Wymagania
- Node.js 18+
- Token bota (DISCORD_TOKEN)
- Application ID (DISCORD_APP_ID)
- ID serwera (GUILD_ID)

## Instalacja
```powershell
cd "C:\Users\tomas\Documents\Playground\Boty-do-fordonrp"
npm install
```

## Uruchomienie (PowerShell)
```powershell
cd "C:\Users\tomas\Documents\Playground\Boty-do-fordonrp"
$env:DISCORD_TOKEN="TWÓJ_TOKEN"
$env:DISCORD_APP_ID="TWOJE_APP_ID"   # z Developer Portal, Application ID
$env:GUILD_ID="1480541127512948931"  # Fordon RP
npm start
```

## Komenda
`/ban-eh nick:"nick_z_gry" reason:"powód" days:"liczba lub perm" moderator:"nazwa moderatora"`

Embed: tytuł „🚫 NOWY BAN NA SERWERZE 🚫”, opis „Fordon RP”, pola jak na screenie (status, powód, czas, moderator, możliwość odwołania: Nie, info/notes/prośba).

## Konfiguracja `.env`
Plik `.env` (utworzony z `.env.example`) trzyma dane:
```
DISCORD_TOKEN=WPISZ_TOKEN
DISCORD_APP_ID=WPISZ_APP_ID
GUILD_ID=1480541127512948931
```
Edytuj `.env`, zapisz, a potem uruchom `npm start`. Bot wczyta wartości automatycznie (dotenv).


Zmiany:
- Komenda to teraz `/ban-eh` (wizualny ban, nie banuje na Discordzie).
- Pole `nick` to nick z gry, nie @mention.
- Pole `days` przyjmuje liczbę dni lub słowo `perm` dla bana na zawsze.


### Konfiguracja kanałów
- Użyj `/configBanEH komendy:#kanał logi:#kanał` (tylko administratorzy) aby ustawić, gdzie wolno pisać /ban-eh i na jaki kanał lecą ogłoszenia.
- Jeśli /ban-eh wywołasz w złym kanale lub bez konfiguracji, bot zwróci komunikat prywatny.


- `/ban-eh` ma teraz parametr `appeal` (Tak/Nie) ustawiający pole „Możliwość odwołania”.


### Skargi na administrację
- Ustaw kanał: `/skargikanal kanal:#kanał` (admin).
- Skargę wysyłasz w tym kanale: `/skarga kto:"nick" komu:"na kogo" powod:"za co"`.
- Komenda zadziała tylko w ustawionym kanale; embed pokazuje trzy pola (kto, komu, za co).


### Role uprawnień
- Dodaj role do zmiany kanałów (/configBanEH, /skargikanal): `/zmienkanalrole rola:@Rola`
- Lista ról do zmiany kanałów: `/zmienrolelist`
- Dodaj role do /ban-eh: `/banrolesadd rola:@Rola`
- Lista ról do /ban-eh: `/banroleslist`
- Uprawnienie jest też przyznawane automatycznie posiadaczom Administrator.


- Dodawanie/usuwanie ról do zmiany kanałów: `/zmienkanalrole rola:@Rola` (tylko Admin), usuwanie: `/zmienkanalroledel rola:@Rola`, podgląd: `/zmienrolelist`.
- Tylko Administrator może nadawać/odbierać uprawnienia do zmiany kanałów (zwykli gracze nie mogą).

