/*
 * A retail-bank workspace written for Boxwire's tests in the shape of the well-known
 * "Big Bank plc" Structurizr example: three people, four software systems, five
 * containers, six components, a group, deployment environments and the usual views.
 * The wording is our own.
 */
workspace "Retail Bank" "Internet banking, modelled with C4." {

    !identifiers flat

    model {
        customer = person "Personal Banking Customer" "A customer of the bank, with personal accounts."

        group "Retail Bank plc" {
            supportStaff = person "Customer Service Staff" "Staff who help customers." "Bank Staff"
            backoffice = person "Back Office Staff" "Administration and support staff." "Bank Staff"

            mainframe = softwareSystem "Mainframe Banking System" "Holds customers, accounts and transactions." "Existing System"
            email = softwareSystem "E-mail System" "The internal mail server." "Existing System"
            atm = softwareSystem "ATM" "Lets customers withdraw cash." "Existing System"

            internetBankingSystem = softwareSystem "Internet Banking System" "Lets customers view their accounts and make payments." {
                singlePageApplication = container "Single-Page Application" "All internet banking features in the browser." "JavaScript and Angular" "Web Browser"
                mobileApp = container "Mobile App" "A subset of features on the phone." "Xamarin" "Mobile App"
                webApplication = container "Web Application" "Serves the single-page application." "Java and Spring MVC"
                apiApplication = container "API Application" "Internet banking over a JSON/HTTPS API." "Java and Spring MVC" {
                    signinController = component "Sign In Controller" "Signs users in." "Spring MVC Rest Controller"
                    accountsSummaryController = component "Accounts Summary Controller" "Lists a customer's accounts." "Spring MVC Rest Controller"
                    resetPasswordController = component "Reset Password Controller" "Resets passwords from a single-use link." "Spring MVC Rest Controller"
                    securityComponent = component "Security Component" "Sign-in and password changes." "Spring Bean"
                    mainframeBankingSystemFacade = component "Mainframe Banking System Facade" "A facade onto the mainframe." "Spring Bean"
                    emailComponent = component "E-mail Component" "Sends e-mails to users." "Spring Bean"
                }
                database = container "Database" "Users, hashed credentials, access logs." "Oracle Database Schema" "Database"
            }
        }

        # people and systems
        customer -> internetBankingSystem "Views accounts and makes payments using"
        internetBankingSystem -> mainframe "Gets account information from, and makes payments using"
        internetBankingSystem -> email "Sends e-mail using"
        email -> customer "Sends e-mails to"
        customer -> supportStaff "Asks questions to" "Telephone"
        supportStaff -> mainframe "Uses"
        customer -> atm "Withdraws cash using"
        atm -> mainframe "Uses"
        backoffice -> mainframe "Uses"

        # containers
        customer -> webApplication "Visits bigbank.example" "HTTPS"
        customer -> singlePageApplication "Views accounts and makes payments using"
        customer -> mobileApp "Views accounts and makes payments using"
        webApplication -> singlePageApplication "Delivers to the customer's browser"

        # components
        singlePageApplication -> signinController "Makes API calls to" "JSON/HTTPS"
        singlePageApplication -> accountsSummaryController "Makes API calls to" "JSON/HTTPS"
        singlePageApplication -> resetPasswordController "Makes API calls to" "JSON/HTTPS"
        mobileApp -> signinController "Makes API calls to" "JSON/HTTPS"
        mobileApp -> accountsSummaryController "Makes API calls to" "JSON/HTTPS"
        mobileApp -> resetPasswordController "Makes API calls to" "JSON/HTTPS"
        signinController -> securityComponent "Uses"
        accountsSummaryController -> mainframeBankingSystemFacade "Uses"
        resetPasswordController -> securityComponent "Uses"
        resetPasswordController -> emailComponent "Uses"
        securityComponent -> database "Reads from and writes to" "JDBC"
        mainframeBankingSystemFacade -> mainframe "Makes API calls to" "XML/HTTPS"
        emailComponent -> email "Sends e-mail using"

        deploymentEnvironment "Development" {
            deploymentNode "Developer Laptop" "" "Windows or macOS" {
                deploymentNode "Docker Container - Web Server" "" "Docker" {
                    containerInstance webApplication
                }
            }
        }
        deploymentEnvironment "Live" {
            deploymentNode "Customer's mobile device" "" "Apple iOS or Android" {
                containerInstance mobileApp
            }
        }
    }

    views {
        systemlandscape "SystemLandscape" {
            include *
            autoLayout
        }
        systemcontext internetBankingSystem "SystemContext" {
            include *
            animation {
                internetBankingSystem
                customer
            }
            autoLayout
            description "The system context diagram for the Internet Banking System."
        }
        container internetBankingSystem "Containers" {
            include *
            autoLayout lr
        }
        component apiApplication "Components" {
            include *
            autoLayout
        }
        dynamic apiApplication "SignIn" "Summarises how sign in works." {
            singlePageApplication -> signinController "Submits credentials to"
            autoLayout
        }
        deployment internetBankingSystem "Live" "LiveDeployment" {
            include *
            autoLayout
        }
        styles {
            element "Person" {
                shape person
            }
            element "Database" {
                shape cylinder
            }
        }
        theme default
    }
}
